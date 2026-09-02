# High-speed mirror script with auto-root folder preservation and 16MB stream chunks
import os
import sys
import argparse
import tempfile
import shutil
import time
import json
import urllib.request
import urllib.parse

def extract_gdrive_id(url_or_id):
    if not url_or_id:
        return "", False
    url_or_id = url_or_id.strip()
    is_folder = "folders/" in url_or_id or "drive/folders" in url_or_id
    if "/folders/" in url_or_id:
        part = url_or_id.split("/folders/")[1]
        return part.split("?")[0].split("/")[0], True
    if "/d/" in url_or_id:
        part = url_or_id.split("/d/")[1]
        return part.split("?")[0].split("/")[0], False
    if "id=" in url_or_id:
        part = url_or_id.split("id=")[1]
        return part.split("&")[0], is_folder
    return url_or_id, is_folder

def get_gdrive_access_token(client_id, client_secret, refresh_token):
    token_url = "https://oauth2.googleapis.com/token"
    payload = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token"
    }
    req = urllib.request.Request(token_url, data=urllib.parse.urlencode(payload).encode(), headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req) as res:
        data = json.loads(res.read().decode())
        return data["access_token"]

def get_file_metadata(file_id, access_token):
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?fields=id,name,mimeType,size&supportsAllDrives=true"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token}"})
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read().decode())
    except Exception:
        return None

def list_gdrive_folder_recursive(folder_id, access_token, base_path=""):
    results = []
    page_token = None
    while True:
        query = f"'{folder_id}' in parents and trashed = false"
        url = f"https://www.googleapis.com/drive/v3/files?q={urllib.parse.quote(query)}&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true"
        if page_token:
            url += f"&pageToken={page_token}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token}"})
        with urllib.request.urlopen(req) as res:
            data = json.loads(res.read().decode())
            for item in data.get("files", []):
                rel_path = f"{base_path}/{item['name']}".strip("/") if base_path else item["name"]
                if item["mimeType"] == "application/vnd.google-apps.folder":
                    results.extend(list_gdrive_folder_recursive(item["id"], access_token, rel_path))
                else:
                    results.append({
                        "id": item["id"],
                        "name": item["name"],
                        "rel_path": rel_path,
                        "size": int(item.get("size", 0))
                    })
            page_token = data.get("nextPageToken")
            if not page_token:
                break
    return results

def download_gdrive_file_stream(file_id, access_token, dest_path):
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&supportsAllDrives=true"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token}"})
    with urllib.request.urlopen(req) as res, open(dest_path, "wb") as out:
        chunk_size = 16 * 1024 * 1024 # 16 MB chunk for ultra fast I/O
        while True:
            chunk = res.read(chunk_size)
            if not chunk:
                break
            out.write(chunk)

def upload_to_hf_with_retry(api, local_file, path_in_repo, repo_id, repo_type="dataset", max_retries=3):
    for attempt in range(1, max_retries + 1):
        try:
            api.upload_file(
                path_or_fileobj=local_file,
                path_in_repo=path_in_repo,
                repo_id=repo_id,
                repo_type=repo_type,
                commit_message=f"Mirror: {path_in_repo}"
            )
            return True
        except Exception as e:
            print(f"    [Retry {attempt}/{max_retries}] Upload error: {e}")
            time.sleep(2)
    return False

def main():
    parser = argparse.ArgumentParser(description="HaruDrive High-Speed Cloud Mirror")
    parser.add_argument("--gdrive_url", default=os.getenv("GDRIVE_URL", ""))
    parser.add_argument("--target_path", default=os.getenv("TARGET_PATH", ""))
    parser.add_argument("--hf_repo", default=os.getenv("HF_REPO_ID", ""))
    parser.add_argument("--hf_token", default=os.getenv("HF_TOKEN", ""))
    parser.add_argument("--repo_type", default=os.getenv("REPO_TYPE", "dataset"))
    parser.add_argument("--client_id", default=os.getenv("GDRIVE_CLIENT_ID", ""))
    parser.add_argument("--client_secret", default=os.getenv("GDRIVE_CLIENT_SECRET", ""))
    parser.add_argument("--refresh_token", default=os.getenv("GDRIVE_REFRESH_TOKEN", ""))
    args = parser.parse_args()

    if not args.gdrive_url:
        print("Error: GDRIVE_URL is required.")
        sys.exit(1)

    from huggingface_hub import HfApi, login

    print(f"Authenticating with Hugging Face Hub (Repo: {args.hf_repo})...")
    login(token=args.hf_token, add_to_git_credential=False)
    api = HfApi(token=args.hf_token)

    gdrive_id, is_folder_url = extract_gdrive_id(args.gdrive_url)
    target_path = args.target_path.strip("/\\") if args.target_path else ""

    print(f"Target Google Drive ID: {gdrive_id}")
    print(f"Base Target HF Directory: /{target_path}\n")

    has_oauth = bool(args.client_id and args.client_secret and args.refresh_token)
    start_time = time.time()
    ok_count = 0
    fail_count = 0

    if has_oauth:
        access_token = get_gdrive_access_token(args.client_id, args.client_secret, args.refresh_token)
        meta = get_file_metadata(gdrive_id, access_token)
        is_folder = is_folder_url or (meta and meta.get("mimeType") == "application/vnd.google-apps.folder")

        if is_folder:
            root_folder_name = meta.get("name", "Folder") if meta else "Folder"
            print(f"Scanning Google Drive folder '{root_folder_name}' contents...")
            files = list_gdrive_folder_recursive(gdrive_id, access_token)
            print(f"Discovered {len(files)} files to mirror.\n")

            # Preserve root folder name so it creates /VIU/Series/... instead of dumping directly into root!
            prefix = f"{target_path}/{root_folder_name}".strip("/") if target_path else root_folder_name

            temp_dir = tempfile.mkdtemp(prefix="haru_mirror_")
            try:
                for idx, file_info in enumerate(files, 1):
                    fid = file_info["id"]
                    rel_p = file_info["rel_path"]
                    sz_mb = file_info["size"] / (1024 * 1024)
                    dest_hf = f"{prefix}/{rel_p}".strip("/")

                    print(f"[{idx}/{len(files)}] Transferring: {dest_hf} ({sz_mb:.1f} MB)...")
                    local_tmp = os.path.join(temp_dir, f"tmp_{idx}_{file_info['name']}")

                    try:
                        download_gdrive_file_stream(fid, access_token, local_tmp)
                        if upload_to_hf_with_retry(api, local_tmp, dest_hf, args.hf_repo, args.repo_type):
                            print(f"    ✓ Uploaded to /{dest_hf}")
                            ok_count += 1
                        else:
                            fail_count += 1
                    except Exception as err:
                        print(f"    ✕ Error on {dest_hf}: {err}")
                        fail_count += 1
                    finally:
                        try: os.remove(local_tmp)
                        except Exception: pass
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)

        else:
            fname = meta.get("name", "downloaded_file") if meta else "downloaded_file"
            sz_mb = int(meta.get("size", 0)) / (1024 * 1024) if meta else 0
            dest_hf = f"{target_path}/{fname}".strip("/") if target_path else fname

            print(f"Downloading single file: {fname} ({sz_mb:.1f} MB)...")
            temp_dir = tempfile.mkdtemp(prefix="haru_file_")
            local_tmp = os.path.join(temp_dir, fname)

            try:
                download_gdrive_file_stream(gdrive_id, access_token, local_tmp)
                if upload_to_hf_with_retry(api, local_tmp, dest_hf, args.hf_repo, args.repo_type):
                    print(f"Successfully mirrored to /{dest_hf}")
                    ok_count = 1
                else:
                    fail_count = 1
            except Exception as e:
                print(f"Error during file mirror: {e}")
                fail_count = 1
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)

    else:
        print("Using gdown fallback mode...")
        import gdown
        temp_dir = tempfile.mkdtemp(prefix="haru_gdown_")
        try:
            if is_folder_url:
                out_folder = os.path.join(temp_dir, "downloads")
                gdown.download_folder(f"https://drive.google.com/drive/folders/{gdrive_id}", output=out_folder, quiet=False, use_cookies=False)
                for root, _, files in os.walk(out_folder):
                    for f in files:
                        fp = os.path.join(root, f)
                        rel = os.path.relpath(fp, out_folder).replace("\\", "/")
                        dest_hf = f"{target_path}/{rel}".strip("/") if target_path else rel
                        if upload_to_hf_with_retry(api, fp, dest_hf, args.hf_repo, args.repo_type):
                            ok_count += 1
                        else:
                            fail_count += 1
                        try: os.remove(fp)
                        except Exception: pass
            else:
                out_file = gdown.download(f"https://drive.google.com/uc?id={gdrive_id}", output=os.path.join(temp_dir, "file_"), quiet=False, fuzzy=True)
                if out_file and os.path.exists(out_file):
                    fname = os.path.basename(out_file)
                    dest_hf = f"{target_path}/{fname}".strip("/") if target_path else fname
                    if upload_to_hf_with_retry(api, out_file, dest_hf, args.hf_repo, args.repo_type):
                        ok_count = 1
                    else:
                        fail_count = 1
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    total_time = time.time() - start_time
    print("=" * 60)
    print(f"Mirror Complete in {total_time:.1f}s | Success: {ok_count} | Failed: {fail_count}")
    print("=" * 60)

if __name__ == "__main__":
    main()
