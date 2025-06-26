#!/usr/bin/env python3
import gdown #type: ignore
import os

def main():
    download_path = "./src/content"
    if not os.path.exists(download_path):
        os.makedirs(download_path)

    google_folder = "https://drive.google.com/drive/folders/1vfdKcqWd4-LZX4HTxQmyhwHiiOMgEece?usp=sharing" 
    gdown.download_folder(google_folder, output=download_path, quiet=True)

if __name__=="__main__":
    main()