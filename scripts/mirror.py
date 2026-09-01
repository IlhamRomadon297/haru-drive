import os
import sys
import shutil
import argparse
import tempfile
import time
from pathlib import Path

def print_banner():
    print("=" * 60)
    print("🌸 HaruDrive Cloud Mirror Engine: GDrive -> Hugging Face")
    print("=" * 60)

def parse_args():
    parser = argparse.ArgumentParser(description="Mirror Google Drive files/folders to Hugging Face Dataset.")
    parser.add_argument("--gdrive-url", type=str, default=os.getenv("GDRIVE_URL"), help="Google Drive File/Folder URL or ID")
    parser.add_argument("--hf-token", type=str, default=os.getenv("HF_TOKEN"), help="Hugging Face User Access Token (Write permission)")
    parser.add_argument("--hf-repo", type=str, default=os.getenv("HF_REPO_ID"), help="Hugging Face Dataset Repo (e.g., username/repo_name)")
    parser.add_argument("--target-path", type=str, default=os.getenv("TARGET_PATH", ""), help="Target subfolder in HF repo (e.g. Movies/2026)")
    parser.add_argument("--repo-type", type=str, default=os.getenv("REPO_TYPE", "dataset"), help="Hugging Face repo type (dataset or model)")
    return parser.parse_args()

def install_dependencies():
    """Ensure required packages are available"""
    required = ["huggingface_hub", "gdown", "tqdm"]
    for pkg in required:
        try:
            __import__(pkg.replace("-", "_"))
        except ImportError:
            print(f"📦 Installing missing dependency: {pkg}...")
            import subprocess
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-U", pkg])

def extract_gdrive_id(url_or_id):
    """Extract clean GDrive ID from URL or return raw ID"""
    if not url_or_id:
        return None
    url = url_or_id.strip()
    if "folders/" in url:
        return url.split("folders/")[1].split("?")[0].split("/")[0]
    if "id=" in url:
        return url.split("id=")[1].split("&")[0]
    if "file/d/" in url:
        return url.split("file/d/")[1].split("/")[0]
    return url

def main():
    print_banner()
    args = parse_args()

    if not args.hf_token:
        print("❌ Error: HF_TOKEN is required. Set env var HF_TOKEN or pass --hf-token")
        sys.exit(1)
    if not args.hf_repo:
        print("❌ Error: HF_REPO_ID is required. Set env var HF_REPO_ID or pass --hf-repo")
        sys.exit(1)
    if not args.gdrive_url:
        print("❌ Error: GDRIVE_URL is required. Set env var GDRIVE_URL or pass --gdrive-url")
        sys.exit(1)

    install_dependencies()
    import gdown
    from huggingface_hub import HfApi, login

    # Authenticate to Hugging Face
    print(f"🔑 Authenticating with Hugging Face Hub (Repo: {args.hf_repo})...")
    login(token=args.hf_token, add_to_git_credential=False)
    api = HfApi(token=args.hf_token)

    # Ensure repository exists
    try:
        api.repo_info(repo_id=args.hf_repo, repo_type=args.repo_type)
        print(f"✅ Hugging Face repo '{args.hf_repo}' verified.")
    except Exception as e:
        print(f"⚠️ Repo not found or error accessing repo: {e}")
        print(f"ℹ️ Creating repo '{args.hf_repo}' (private=True)...")
        api.create_repo(repo_id=args.hf_repo, repo_type=args.repo_type, private=True, exist_ok=True)

    gdrive_id = extract_gdrive_id(args.gdrive_url)
    target_path = args.target_path.strip("/\\") if args.target_path else ""

    temp_dir = tempfile.mkdtemp(prefix="harudrive_mirror_")
    print(f"📂 Created temporary workspace: {temp_dir}")

    start_time = time.time()
    try:
        # Check if URL is folder or file
        is_folder = "folder" in args.gdrive_url.lower() or len(gdrive_id) > 25

        download_success = False
        print(f"⬇️ Starting download from Google Drive (ID: {gdrive_id})...")

        # Try folder download first if suspected folder
        if is_folder:
            print("📁 Attempting folder download with gdown...")
            folder_url = f"https://drive.google.com/drive/folders/{gdrive_id}"
            output_folder = os.path.join(temp_dir, "downloads")
            try:
                gdown.download_folder(folder_url, output=output_folder, quiet=False, use_cookies=False)
                if os.path.exists(output_folder) and os.listdir(output_folder):
                    download_success = True
                    download_dir = output_folder
            except Exception as e:
                print(f"⚠️ Folder download notice: {e}. Trying single file download fallback...")

        # Fallback to single file download
        if not download_success:
            file_url = f"https://drive.google.com/uc?id={gdrive_id}"
            output_file = gdown.download(file_url, output=os.path.join(temp_dir, ""), quiet=False, fuzzy=True)
            if output_file and os.path.exists(output_file):
                download_success = True
                download_dir = temp_dir

        if not download_success:
            print("❌ Download failed. Please check GDrive link permissions (Must be 'Anyone with the link can view' or public).")
            sys.exit(1)

        download_duration = time.time() - start_time
        print(f"✅ Download completed in {download_duration:.1f}s")

        # Upload to Hugging Face
        print(f"🚀 Uploading files to Hugging Face ({args.hf_repo} -> /{target_path})...")
        upload_start = time.time()

        # Check files to upload
        files_to_upload = []
        for root, _, files in os.walk(download_dir):
            for file in files:
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, download_dir)
                size_mb = os.path.getsize(full_path) / (1024 * 1024)
                files_to_upload.append((full_path, rel_path, size_mb))

        print(f"📊 Total files discovered: {len(files_to_upload)}")
        for idx, (fpath, rel, sz) in enumerate(files_to_upload, 1):
            dest_path = f"{target_path}/{rel}".strip("/") if target_path else rel
            print(f"  [{idx}/{len(files_to_upload)}] Uploading '{rel}' ({sz:.2f} MB) -> '{dest_path}'...")
            api.upload_file(
                path_or_fileobj=fpath,
                path_in_repo=dest_path,
                repo_id=args.hf_repo,
                repo_type=args.repo_type,
                commit_message=f"🌸 HaruDrive Mirror: {rel}"
            )
            print(f"  ✅ Uploaded '{dest_path}'")

        upload_duration = time.time() - upload_start
        total_duration = time.time() - start_time
        print("=" * 60)
        print(f"🎉 Mirror Complete in {total_duration:.1f}s (Download: {download_duration:.1f}s, Upload: {upload_duration:.1f}s)")
        print(f"🔗 View in HaruDrive or HF: https://huggingface.co/datasets/{args.hf_repo}")
        print("=" * 60)

    finally:
        print(f"🧹 Cleaning up temporary workspace: {temp_dir}")
        shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == "__main__":
    main()
