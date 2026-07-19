#!/bin/bash
cd ~/Repos/morning-post
git diff HEAD~1 --stat
echo "===DIFF==="
git diff HEAD~1
