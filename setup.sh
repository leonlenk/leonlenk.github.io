#!/bin/bash

GET_CONTENT_EXE="./scripts/python/get_content.pyz"

if [ -f "$GET_CONTENT_EXE" ]; then
    python3 "$GET_CONTENT_EXE"
else
    cd scripts/python || exit 1
    bash generate_pyz.sh
    cd ../../
    python3 "$GET_CONTENT_EXE"
fi
