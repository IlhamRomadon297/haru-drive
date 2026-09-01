import os
import sys
import shutil
import argparse
import tempfile
import time
import subprocess
from pathlib import Path


def print_banner():
    print("=" * 60)
    print("HaruDrive Cloud Mirror Engine: GDrive -> Hugging Face")
    print("=" * 60)


def parse_args():
    parser = argparse.ArgumentParser(description="Mirror Google Drive files/folders to Hugging Face Dataset.")
    parser.add_argument("--gdrive-url", type=str, default=os.getenv("GDRIVE_URL"))
    parser.add_argument("--hf-token", type=str, default=os.getenv("HF_TOKEN"))
    parser.add_argument("--hf-repo", type=str, default=os.getenv("HF_REPO_ID"))
    parser.add_argument("--target-path", type=str, default=os.getenv("TARGET_PATH", ""))
    parser.add_argument("--repo-type", type=str, default=os.getenv("REPO_TYPE", "dataset"))
    return parser.parse_args()


def ensure_packages():
    """Ensure required packages are installed at needed versions"""
    # Force upgrade gdown to get fuzzy support
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", "gdown>=5.2.0", "huggingface_hub>=0.24.0", "-q"])


def extract_gdrive_id(url_or_id):
    """Extract clean GDrive ID from URL or return raw ID"""
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


def get_disk_free_gb(path="/tmp"):
    stat = shutil.disk_usage(path)
    return stat.free / (1024 ** 3)


def main():
    print_banner()
    args = parse_args()

    if not args.hf_token:
        print("Error: HF_TOKEN is required.")
        sys.exit(1)
    if not args.hf_repo:
        print("Error: HF_REPO_ID is required.")
        sys.exit(1)
    if not args.gdrive_url:
        print("Error: GDRIVE_URL is required.")
        sys.exit(1)

    ensure_packages()

    import gdown
    from huggingface_hub import HfApi, login

    print("gdown version:", gdown.__version__)

    print("Authenticating with Hugging Face Hub (Repo:", args.hf_repo, ")...")
    login(token=args.hf_token, add_to_git_credential=False)
    api = HfApi(token=args.hf_token)

    try:
        api.repo_info(repo_id=args.hf_repo, repo_type=args.repo_type)
        print("Hugging Face repo verified:", args.hf_repo)
    except Exception as e:
        print("Repo not found:", e)
        print("Creating repo:", args.hf_repo)
        api.create_repo(repo_id=args.hf_repo, repo_type=args.repo_type, private=True, exist_ok=True)

    gdrive_id, is_folder_url = extract_gdrive_id(args.gdrive_url)
    target_path = args.target_path.strip("/\\") if args.target_path else ""

    free_gb = get_disk_free_gb("/tmp")
    print("Free disk space: {:.2f} GB".format(free_gb))
    if free_gb < 2.0:
        print("WARNING: Low disk. Files larger than {:.1f}GB may fail.".format(free_gb - 0.5))

    temp_dir = tempfile.mkdtemp(prefix="harudrive_mirror_")
    print("Temporary workspace:", temp_dir)

    start_time = time.time()

    try:
        download_success = False
        download_dir = None

        if is_folder_url:
            print("Attempting folder download (ID:", gdrive_id, ")...")
            folder_url = "https://drive.google.com/drive/folders/" + gdrive_id
            output_folder = os.path.join(temp_dir, "downloads")
            try:
                result = gdown.download_folder(
                    folder_url,
                    output=output_folder,
                    quiet=False,
                    use_cookies=False,
                    remaining_ok=True
                )
                if result and os.path.exists(output_folder) and os.listdir(output_folder):
                    download_success = True
                    download_dir = output_folder
            except Exception as e:
                err_str = str(e)
                print("Folder download error:", err_str)
                if "No space left" in err_str or "Errno 28" in err_str:
                    print("FATAL: Disk full. Please use a smaller folder or single file URL.")
                    sys.exit(1)
                print("Falling back to single file download...")

        if not download_success:
            print("Attempting single file download (ID:", gdrive_id, ")...")
            file_url = "https://drive.google.com/uc?id=" + gdrive_id
            output_path = os.path.join(temp_dir, "download_file")

            # Try with fuzzy first (gdown >= 5.2.0), fallback to without
            try:
                output_file = gdown.download(url=file_url, output=output_path, quiet=False, fuzzy=True)
            except TypeError:
                print("gdown version does not support fuzzy, using basic download...")
                output_file = gdown.download(url=file_url, output=output_path, quiet=False)

            if output_file and os.path.exists(output_file):
                download_success = True
                download_dir = temp_dir
            else:
                print("Error: Download returned no file. Check GDrive permissions.")
                sys.exit(1)

        if not download_success or not download_dir:
            print("Error: Download failed.")
            sys.exit(1)

        download_duration = time.time() - start_time
        print("Download completed in {:.1f}s".format(download_duration))

        print("Uploading files to Hugging Face ({} -> /{})...".format(args.hf_repo, target_path))
        upload_start = time.time()

        files_to_upload = []
        for root, _, files in os.walk(download_dir):
            for file in files:
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, download_dir)
                size_mb = os.path.getsize(full_path) / (1024 * 1024)
                files_to_upload.append((full_path, rel_path, size_mb))

        print("Total files to upload:", len(files_to_upload))

        for idx, (fpath, rel, sz) in enumerate(files_to_upload, 1):
            dest_path = "{}/{}".format(target_path, rel).strip("/") if target_path else rel
            dest_path = dest_path.replace("\\", "/")
            print("  [{}/{}] Uploading '{}' ({:.2f} MB) -> '{}'...".format(
                idx, len(files_to_upload), rel, sz, dest_path))
            try:
                api.upload_file(
                    path_or_fileobj=fpath,
                    path_in_repo=dest_path,
                    repo_id=args.hf_repo,
                    repo_type=args.repo_type,
                    commit_message="HaruDrive Mirror: " + rel
                )
                print("  Uploaded successfully:", dest_path)
            except Exception as e:
                print("  WARNING: Failed to upload '{}': {}".format(dest_path, e))

        upload_duration = time.time() - upload_start
        total_duration = time.time() - start_time
        print("=" * 60)
        print("Mirror Complete in {:.1f}s (Download: {:.1f}s, Upload: {:.1f}s)".format(
            total_duration, download_duration, upload_duration))
        print("View at: https://huggingface.co/datasets/" + args.hf_repo)
        print("=" * 60)

    finally:
        print("Cleaning up workspace:", temp_dir)
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()