#!/bin/bash
# Custom startup: set up Chrome profile symlink, then launch Kasm VNC

# Symlink Chrome profile to the mounted Chromium profile directory
# so Chrome uses the same persistent storage that's bind-mounted
if [ ! -L "$HOME/.config/google-chrome" ]; then
    rm -rf "$HOME/.config/google-chrome" 2>/dev/null
    ln -s "$HOME/.config/chromium" "$HOME/.config/google-chrome" 2>/dev/null || true
fi

# Patch: skip wait_for_network_devices for --network host
sed 's/^wait_for_network_devices$/# wait_for_network_devices/' /dockerstartup/vnc_startup.sh > /tmp/vnc_patched.sh
chmod +x /tmp/vnc_patched.sh
exec /tmp/vnc_patched.sh "$@"
