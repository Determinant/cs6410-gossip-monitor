#!/bin/bash
# 1. Before running this script, run `node ./server.js` and then type
# "+127.0.0.1:5555\n" in the server console to add the netcat
# emulated peer (without quotation marks).

# 2. Run this script:
printf '128.84.213.13:5678,1630281124,1\n128.84.213.43:9876,1630282312,7\n' | netcat -l -c -p 5555

# 3. Then, http://localhost:8080/ should show the node statistics (there should be 3 nodes).
