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

GOFILE_API_BASE = "https://go.filmbeehub.workers.dev"

def detect_source(url):
    u = (url or "").strip().lower()
    if "gofile.io" in u:
        return "gofile"
    return "gdrive"

def extract_gofile_id(url):
    u = (url or "").strip()
    if "/d/" in u:
        part = u.split("/d/", 1)[1]
        return part.split("?")[0].split("/")[0].split("#")[0]
    return u

def normalize_gofile_file(f):
    if not isinstance(f, dict):
        return None
    name = f.get("name") or f.get("fileName") or f.get("filename") or ""
    link = f.get("downloadUrl") or f.get("link") or f.get("url") or f.get("directLink") or f.get("content") or ""
    size = f.get("bytes") or f.get("size") or f.get("fileSize") or 0
    try:
        size = int(size)
    except Exception:
        try:
            import re as _re
            m = _re.match(r"\s*([\d.]+)\s*([KMGT]?B)", str(size), _re.I)
            mult = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}
            size = int(float(m.group(1)) * mult.get(m.group(2).upper(), 1)) if m else 0
        except Exception:
            size = 0
    if not name:
        try:
            from urllib.parse import unquote as _unq
            name = _unq((link or "").rstrip("/").split("/")[-1].split("?")[0]) or "file"
        except Exception:
            name = "file"
    if not link:
        return None
    return {"name": name, "link": link, "size": size}

def parse_gofile_response(data):
    files = []
    folder_name = ""
    if isinstance(data, dict):
        d = data.get("data")
        if isinstance(d, dict):
            dl = d.get("downloadLinks")
            if isinstance(dl, list):
                folder_name = d.get("name") or ""
                for f in dl:
                    n = normalize_gofile_file(f)
                    if n:
                        files.append(n)
                return files, folder_name
            ch = d.get("children")
            if isinstance(ch, dict):
                folder_name = d.get("name") or ""
                for _, f in ch.items():
                    n = normalize_gofile_file(f)
                    if n:
                        files.append(n)
                return files, folder_name
            if isinstance(ch, list):
                folder_name = d.get("name") or ""
                for f in ch:
                    n = normalize_gofile_file(f)
                    if n:
                        files.append(n)
                return files, folder_name
        for key in ("files", "links", "data"):
            c = data.get(key)
            if isinstance(c, list):
                for f in c:
                    n = normalize_gofile_file(f)
                    if n:
                        files.append(n)
                if files:
                    break
        for key in ("folderName", "folder_name", "name"):
            v = data.get(key)
            if isinstance(v, str) and v:
                folder_name = v
                break
    elif isinstance(data, list):
        for f in data:
            n = normalize_gofile_file(f)
            if n:
                files.append(n)
    return files, folder_name

def resolve_gofile_files(api_base, api_token, gofile_url, password="", page_size=100, max_pages=50):
    gid = extract_gofile_id(gofile_url)
    if not gid:
        raise Exception("Gofile ID tidak valid.")
    if not api_token:
        raise Exception("GOFILE_API_TOKEN belum diset (GitHub Secrets / Colab Secrets).")
    headers = {"Authorization": f"Bearer {api_token}", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"}
    files = []
    folder_name = ""
    seen = set()
    page = 0
    while page < max_pages:
        payload = json.dumps({"url": f"https://gofile.io/d/{gid}", "password": password or "", "expiresInSeconds": 3600, "filePage": page, "filePageSize": page_size})
        data = None
        for api_attempt in range(1, 4):
            try:
                req = urllib.request.Request(api_base.rstrip("/") + "/api/v1/generate", data=payload.encode(), headers=headers)
                with urllib.request.urlopen(req, timeout=60) as res:
                    data = json.loads(res.read().decode())
                break
            except urllib.error.HTTPError as e:
                if e.code in (403, 429, 503) and api_attempt < 3:
                    wait = 60 * api_attempt
                    print(f"    Gofile API throttled (HTTP {e.code}), retry {api_attempt}/3 in {wait}s...")
                    time.sleep(wait)
                    continue
                raise Exception(f"Gofile API error (page {page}): HTTP {e.code} - upstream throttled, coba lagi nanti.")
            except Exception as e:
                raise Exception(f"Gofile API error (page {page}): {e}")
        if data is None:
            raise Exception(f"Gofile API error (page {page}): no response after retries.")
        if isinstance(data, dict) and data.get("ok") is False and "status" not in data:
            raise Exception(f"Gofile API: {data.get('error', 'unknown error')}")
        batch, bname = parse_gofile_response(data)
        if bname and not folder_name:
            folder_name = bname
        new_count = 0
        for f in batch:
            key = f["link"] or f["name"]
            if key in seen:
                continue
            seen.add(key)
            files.append(f)
            new_count += 1
        try:
            dd = data.get("data", {}) if isinstance(data, dict) else {}
            has_more = dd.get("hasMoreFiles", None)
        except Exception:
            has_more = None
        if has_more is False:
            break
        if has_more is True:
            page += 1
            continue
        if len(batch) < page_size or new_count == 0:
            break
        page += 1
    return files, folder_name, gid

def download_url_stream(url, dest_path, max_retries=4):
    last_err = None
    for attempt in range(1, max_retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "HaruDrive-Mirror/1.0"})
            with urllib.request.urlopen(req, timeout=180) as res, open(dest_path, "wb") as out:
                while True:
                    chunk = res.read(16 * 1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            return dest_path
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 503) and attempt < max_retries:
                wait = 30 * attempt
                print(f"    Rate limited upstream (HTTP {e.code}), retry {attempt}/{max_retries} in {wait}s...")
                time.sleep(wait)
                continue
            raise
    raise last_err

def decide_container(custom_name, api_folder_name, fallback_id, file_count):
    custom = (custom_name or "").strip("/\\ ")
    if custom:
        return custom
    if file_count <= 1:
        return ""
    if api_folder_name:
        return api_folder_name.strip("/\\ ")
    return f"Gofile_{fallback_id[:8]}"

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
    parser.add_argument("--source_url", default=os.getenv("SOURCE_URL", ""))
    parser.add_argument("--folder_name", default=os.getenv("FOLDER_NAME", ""))
    parser.add_argument("--gofile_token", default=os.getenv("GOFILE_API_TOKEN", ""))
    parser.add_argument("--gofile_password", default=os.getenv("GOFILE_PASSWORD", ""))
    parser.add_argument("--target_path", default=os.getenv("TARGET_PATH", ""))
    parser.add_argument("--hf_repo", default=os.getenv("HF_REPO_ID", ""))
    parser.add_argument("--hf_token", default=os.getenv("HF_TOKEN", ""))
    parser.add_argument("--repo_type", default=os.getenv("REPO_TYPE", "dataset"))
    parser.add_argument("--client_id", default=os.getenv("GDRIVE_CLIENT_ID", ""))
    parser.add_argument("--client_secret", default=os.getenv("GDRIVE_CLIENT_SECRET", ""))
    parser.add_argument("--refresh_token", default=os.getenv("GDRIVE_REFRESH_TOKEN", ""))
    args = parser.parse_args()

    source_url = (args.source_url or args.gdrive_url or "").strip()
    if not source_url:
        print("Error: SOURCE_URL (or GDRIVE_URL) is required.")
        sys.exit(1)
    source_kind = detect_source(source_url)

    from huggingface_hub import HfApi, login

    print(f"Authenticating with Hugging Face Hub (Repo: {args.hf_repo})...")
    login(token=args.hf_token, add_to_git_credential=False)
    api = HfApi(token=args.hf_token)

    target_path = args.target_path.strip("/\\") if args.target_path else ""
    custom_folder = (args.folder_name or "").strip("/\\ ")

    print(f"Source: {source_kind} | URL: {source_url}")
    print(f"Base Target HF Directory: /{target_path}\n")

    has_oauth = bool(args.client_id and args.client_secret and args.refresh_token)
    start_time = time.time()
    ok_count = 0
    fail_count = 0

    if source_kind == "gofile":
        gofile_token = args.gofile_token or os.getenv("GOFILE_API_TOKEN", "")
        print(f"Resolving Gofile folder: {source_url}")
        try:
            go_files, go_folder_name, go_gid = resolve_gofile_files(GOFILE_API_BASE, gofile_token, source_url)
        except Exception as e:
            print(f"Error: {e}")
            sys.exit(1)
        print(f"Discovered {len(go_files)} files" + (f" in '{go_folder_name}'" if go_folder_name else "") + ".\n")
        if not go_files:
            print("Tidak ada file yang bisa di-mirror.")
            return
        container = decide_container(custom_folder, go_folder_name, go_gid, len(go_files))
        temp_dir = tempfile.mkdtemp(prefix="haru_gofile_")
        try:
            for idx, gf in enumerate(go_files, 1):
                parts = [target_path, container, gf["name"]]
                dest_hf = "/".join([p for p in parts if p])
                sz_mb = gf["size"] / (1024 * 1024)
                print(f"[{idx}/{len(go_files)}] Downloading: {gf['name']} ({sz_mb:.1f} MB)...")
                local_tmp = os.path.join(temp_dir, f"gofile_{idx}")
                try:
                    download_url_stream(gf["link"], local_tmp)
                    if upload_to_hf_with_retry(api, local_tmp, dest_hf, args.hf_repo, args.repo_type):
                        print(f"    ✓ Uploaded to /{dest_hf}")
                        ok_count += 1
                    else:
                        fail_count += 1
                except Exception as err:
                    print(f"    ✕ Error on {dest_hf}: {err}")
                    fail_count += 1
                finally:
                    try:
                        os.remove(local_tmp)
                    except Exception:
                        pass
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
        total_time = time.time() - start_time
        print("=" * 60)
        print(f"Mirror Complete in {total_time:.1f}s | Success: {ok_count} | Failed: {fail_count}")
        print("=" * 60)
        return

    gdrive_id, is_folder_url = extract_gdrive_id(source_url)
    print(f"Target Google Drive ID: {gdrive_id}")

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
            # --folder_name overrides the container folder when provided.
            container = custom_folder or root_folder_name
            prefix = f"{target_path}/{container}".strip("/") if target_path else container

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
            if custom_folder:
                dest_hf = "/".join([p for p in [target_path, custom_folder, fname] if p])
            else:
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
