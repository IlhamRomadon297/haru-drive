import os
import sys
import shutil
import argparse
import tempfile
import time
import subprocess
import requests
from pathlib import Path

def print_banner():
    print("=" * 60)
    print("🌸 HaruDrive Ultimate Cloud Mirror Engine (Google Drive API v3 ➔ Hugging Face)")
    print("=" * 60)

def parse_args():
    parser = argparse.ArgumentParser(description="Mirror Google Drive files/folders to Hugging Face Dataset.")
    parser.add_argument("--gdrive-url", type=str, default=os.getenv("GDRIVE_URL"), help="Google Drive File/Folder URL or ID")
    parser.add_argument("--hf-token", type=str, default=os.getenv("HF_TOKEN"), help="Hugging Face User Access Token (Write permission)")
    parser.add_argument("--hf-repo", type=str, default=os.getenv("HF_REPO_ID"), help="Hugging Face Dataset Repo (e.g., username/repo_name)")
    parser.add_argument("--target-path", type=str, default=os.getenv("TARGET_PATH", ""), help="Target subfolder in HF repo (e.g. Movies/2026)")
    parser.add_argument("--repo-type", type=str, default=os.getenv("REPO_TYPE", "dataset"), help="Hugging Face repo type (dataset or model)")
    # Google OAuth2 Credentials
    parser.add_argument("--client-id", type=str, default=os.getenv("GDRIVE_CLIENT_ID"), help="Google OAuth Client ID")
    parser.add_argument("--client-secret", type=str, default=os.getenv("GDRIVE_CLIENT_SECRET"), help="Google OAuth Client Secret")
    parser.add_argument("--refresh-token", type=str, default=os.getenv("GDRIVE_REFRESH_TOKEN"), help="Google OAuth Refresh Token")
    return parser.parse_args()

def extract_gdrive_id(url_or_id):
    """Extract clean GDrive ID from URL or return raw ID and detect if folder"""
    if not url_or_id:
        return None, False
    url = url_or_id.strip()
    is_folder = "folders/" in url or ("folder" in url.lower() and "file" not in url.lower())
    if "folders/" in url:
        fid = url.split("folders/")[1].split("?")[0].split("/")[0]
        return fid, True
    if "id=" in url:
        return url.split("id=")[1].split("&")[0], is_folder
    if "file/d/" in url:
        return url.split("file/d/")[1].split("/")[0], False
    return url, is_folder

def get_gdrive_access_token(client_id, client_secret, refresh_token):
    """Fetch fresh access token using OAuth refresh token"""
    token_url = "https://oauth2.googleapis.com/token"
    payload = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token"
    }
    r = requests.post(token_url, data=payload, timeout=30)
    if r.status_code == 200:
        data = r.json()
        return data.get("access_token")
    else:
        raise Exception(f"OAuth Token Error ({r.status_code}): {r.text}")

def list_gdrive_folder_recursive(folder_id, access_token, current_path=""):
    """Recursively list all files and subfolder paths via Google Drive API v3"""
    headers = {"Authorization": f"Bearer {access_token}"}
    files_list = []
    page_token = None

    while True:
        url = "https://www.googleapis.com/drive/v3/files"
        params = {
            "q": f"'{folder_id}' in parents and trashed = false",
            "fields": "nextPageToken, files(id, name, mimeType, size)",
            "pageSize": 1000,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true"
        }
        if page_token:
            params["pageToken"] = page_token

        res = requests.get(url, headers=headers, params=params, timeout=30)
        res.raise_for_status()
        data = res.json()

        for item in data.get("files", []):
            item_name = item.get("name", "untitled")
            item_mime = item.get("mimeType", "")
            item_id = item.get("id")

            if item_mime == "application/vnd.google-apps.folder":
                # Recursive call into subfolder
                sub_path = f"{current_path}/{item_name}".strip("/") if current_path else item_name
                sub_files = list_gdrive_folder_recursive(item_id, access_token, sub_path)
                files_list.extend(sub_files)
            else:
                rel_path = f"{current_path}/{item_name}".strip("/") if current_path else item_name
                files_list.append({
                    "id": item_id,
                    "name": item_name,
                    "rel_path": rel_path,
                    "size": int(item.get("size", 0))
                })

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return files_list

def get_file_metadata(file_id, access_token):
    """Retrieve single file metadata via Google Drive API"""
    headers = {"Authorization": f"Bearer {access_token}"}
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?fields=id,name,mimeType,size&supportsAllDrives=true"
    res = requests.get(url, headers=headers, timeout=30)
    if res.status_code == 200:
        return res.json()
    return None

def download_gdrive_file_stream(file_id, access_token, dest_path):
    """Stream download file directly to local path in 10MB chunks"""
    headers = {"Authorization": f"Bearer {access_token}"}
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&supportsAllDrives=true"
    
    with requests.get(url, headers=headers, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=10 * 1024 * 1024):
                if chunk:
                    f.write(chunk)
    return dest_path

def upload_to_hf_with_retry(api, local_file, hf_dest_path, repo_id, repo_type="dataset", retries=3):
    """Upload single file to Hugging Face with auto-retry"""
    for attempt in range(retries):
        try:
            api.upload_file(
                path_or_fileobj=local_file,
                path_in_repo=hf_dest_path,
                repo_id=repo_id,
                repo_type=repo_type,
                commit_message=f"HaruDrive Cloud Mirror: {os.path.basename(hf_dest_path)}"
            )
            return True
        except Exception as e:
            print(f"   ⚠️ Upload attempt {attempt + 1}/{retries} error: {e}")
            time.sleep(4)
    return False

def main():
    print_banner()
    args = parse_args()

    if not args.hf_token:
        print("❌ Error: HF_TOKEN is required.")
        sys.exit(1)
    if not args.hf_repo:
        print("❌ Error: HF_REPO_ID is required.")
        sys.exit(1)
    if not args.gdrive_url:
        print("❌ Error: GDRIVE_URL is required.")
        sys.exit(1)

    from huggingface_hub import HfApi, login

    # Authenticate to Hugging Face
    print(f"🔑 Authenticating with Hugging Face Hub (Repo: {args.hf_repo})...")
    login(token=args.hf_token, add_to_git_credential=False)
    api = HfApi(token=args.hf_token)

    try:
        api.repo_info(repo_id=args.hf_repo, repo_type=args.repo_type)
        print(f"✅ Hugging Face repo '{args.hf_repo}' verified.")
    except Exception:
        print(f"📦 Creating repo '{args.hf_repo}' (private=True)...")
        api.create_repo(repo_id=args.hf_repo, repo_type=args.repo_type, private=True, exist_ok=True)

    gdrive_id, is_folder_url = extract_gdrive_id(args.gdrive_url)
    target_path = args.target_path.strip("/\\") if args.target_path else ""

    print(f"🔗 Target Google Drive ID: {gdrive_id} (Folder: {is_folder_url})")
    print(f"🎯 Target Hugging Face Directory: /{target_path}\n")

    # Check if Google Drive OAuth2 credentials are provided
    has_oauth = bool(args.client_id and args.client_secret and args.refresh_token)

    if has_oauth:
        print("🛡️ Google Drive OAuth2 Credentials detected! Using Official Google Drive API v3 (100% Anti-Limit)...")
        try:
            access_token = get_gdrive_access_token(args.client_id, args.client_secret, args.refresh_token)
            print("✅ Successfully acquired Google Drive OAuth Access Token!")
        except Exception as e:
            print(f"❌ Failed to obtain Google Drive access token: {e}")
            sys.exit(1)

        start_time = time.time()
        ok_count = 0
        fail_count = 0

        # Check metadata to verify if it's folder or file
        meta = get_file_metadata(gdrive_id, access_token)
        is_folder = is_folder_url or (meta and meta.get("mimeType") == "application/vnd.google-apps.folder")

        if is_folder:
            folder_name = meta.get("name", "Folder") if meta else "Folder"
            print(f"📂 Scanning folder '{folder_name}' contents recursively...")
            files = list_gdrive_folder_recursive(gdrive_id, access_token)
            print(f"📋 Discovered {len(files)} files to mirror.\n")

            temp_dir = tempfile.mkdtemp(prefix="haru_oauth_")
            try:
                for idx, file_info in enumerate(files, 1):
                    fid = file_info["id"]
                    rel_p = file_info["rel_path"]
                    sz_mb = file_info["size"] / (1024 * 1024)
                    dest_hf = f"{target_path}/{rel_p}".strip("/") if target_path else rel_p

                    print(f"[{idx}/{len(files)}] ⚡ Transferring: {rel_p} ({sz_mb:.1f} MB)...")
                    local_tmp = os.path.join(temp_dir, f"part_{idx}_{file_info['name']}")

                    # 1. Download directly from API
                    try:
                        download_gdrive_file_stream(fid, access_token, local_tmp)
                    except Exception as err:
                        print(f"   ❌ Download failed for {rel_p}: {err}")
                        fail_count += 1
                        continue

                    # 2. Upload to Hugging Face
                    if upload_to_hf_with_retry(api, local_tmp, dest_hf, args.hf_repo, args.repo_type):
                        print(f"   ✅ Uploaded to /{dest_hf}")
                        ok_count += 1
                    else:
                        print(f"   ❌ Upload failed for /{dest_hf}")
                        fail_count += 1

                    # 3. Free disk space immediately!
                    try:
                        os.remove(local_tmp)
                    except Exception:
                        pass

            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)

        else:
            # Single file mode
            fname = meta.get("name", "downloaded_file") if meta else "downloaded_file"
            sz_mb = int(meta.get("size", 0)) / (1024 * 1024) if meta else 0
            dest_hf = f"{target_path}/{fname}".strip("/") if target_path else fname

            print(f"⚡ Downloading single file: {fname} ({sz_mb:.1f} MB)...")
            temp_dir = tempfile.mkdtemp(prefix="haru_oauth_file_")
            local_tmp = os.path.join(temp_dir, fname)

            try:
                download_gdrive_file_stream(gdrive_id, access_token, local_tmp)
                print(f"⚡ Uploading to Hugging Face: /{dest_hf}...")
                if upload_to_hf_with_retry(api, local_tmp, dest_hf, args.hf_repo, args.repo_type):
                    print(f"✅ Successfully mirrored to /{dest_hf}")
                    ok_count = 1
                else:
                    print(f"❌ Upload failed for /{dest_hf}")
                    fail_count = 1
            except Exception as e:
                print(f"❌ Error during file mirror: {e}")
                fail_count = 1
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)

        total_time = time.time() - start_time
        print("=" * 60)
        print(f"🎉 Mirror Complete in {total_time:.1f}s | Success: {ok_count} | Failed: {fail_count}")
        print(f"🌐 View at: https://huggingface.co/datasets/{args.hf_repo}")
        print("=" * 60)

    else:
        # Fallback to gdown mode if no OAuth credentials
        print("ℹ️ No Google OAuth credentials provided. Using gdown fallback mode...")
        import gdown

        temp_dir = tempfile.mkdtemp(prefix="harudrive_gdown_")
        start_time = time.time()
        ok_count = 0
        fail_count = 0

        try:
            if is_folder_url:
                out_folder = os.path.join(temp_dir, "downloads")
                try:
                    gdown.download_folder(f"https://drive.google.com/drive/folders/{gdrive_id}", output=out_folder, quiet=False, use_cookies=False)
                except Exception as e:
                    print(f"⚠️ gdown folder download error: {e}")

                files_to_upload = []
                if os.path.exists(out_folder):
                    for root, _, files in os.walk(out_folder):
                        for f in files:
                            fp = os.path.join(root, f)
                            rel = os.path.relpath(fp, out_folder).replace("\\", "/")
                            files_to_upload.append((fp, rel))

                print(f"📋 Discovered {len(files_to_upload)} files via gdown.")
                for idx, (fpath, rel) in enumerate(files_to_upload, 1):
                    dest_hf = f"{target_path}/{rel}".strip("/") if target_path else rel
                    if upload_to_hf_with_retry(api, fpath, dest_hf, args.hf_repo, args.repo_type):
                        ok_count += 1
                        try: os.remove(fpath)
                        except Exception: pass
                    else:
                        fail_count += 1
            else:
                out_file = None
                try:
                    out_file = gdown.download(f"https://drive.google.com/uc?id={gdrive_id}", output=os.path.join(temp_dir, "file_"), quiet=False, fuzzy=True)
                except TypeError:
                    out_file = gdown.download(f"https://drive.google.com/uc?id={gdrive_id}", output=os.path.join(temp_dir, "file_"), quiet=False)

                if out_file and os.path.exists(out_file):
                    fname = os.path.basename(out_file)
                    dest_hf = f"{target_path}/{fname}".strip("/") if target_path else fname
                    if upload_to_hf_with_retry(api, out_file, dest_hf, args.hf_repo, args.repo_type):
                        ok_count = 1
                    else:
                        fail_count = 1
                else:
                    fail_count = 1

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

        total_time = time.time() - start_time
        print("=" * 60)
        print(f"🎉 Mirror Complete in {total_time:.1f}s | Success: {ok_count} | Failed: {fail_count}")
        print("=" * 60)

if __name__ == "__main__":
    main()
