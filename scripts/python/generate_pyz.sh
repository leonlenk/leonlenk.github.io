#!/bin/bash
mkdir build_dir
pip install --target build_dir gdown
cp get_content.py build_dir/
shiv --site-packages build_dir -e get_content.main -o get_content.pyz
rm -r build_dir