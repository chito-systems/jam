"""Run a shell in a real PTY for the JAM bridge, without a native Node module.

usage: pty_helper.py <shell> <cols> <rows>
stdin  -> shell input (raw bytes)
stdout <- shell output (raw bytes)
fd 3   -> resize requests, one "<cols> <rows>\\n" per line
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    shell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    pid, master = pty.fork()
    if pid == 0:
        set_size(0, cols, rows)
        os.environ["TERM"] = "xterm-256color"
        os.execvp(shell, [shell, "-l", "-i"])

    # The bridge stops us with SIGTERM; Ctrl+C in the bridge's terminal is its business, not ours.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))

    pending = b""
    try:
        while True:
            ready, _, _ = select.select([master, 0, 3], [], [])
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:  # EIO: the shell exited
                    break
                if not data:
                    break
                os.write(1, data)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:  # the bridge closed the socket
                    break
                os.write(master, data)
            if 3 in ready:
                chunk = os.read(3, 1024)
                if not chunk:
                    break
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    parts = line.split()
                    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                        set_size(master, int(parts[0]), int(parts[1]))
    finally:
        stop(pid, master)


def stop(pid, master):
    """Hang up the shell's process group, then make sure it is gone."""
    for sig in (signal.SIGHUP, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except OSError:
            pass
        if sig == signal.SIGHUP:
            try:
                os.close(master)
            except OSError:
                pass
        for _ in range(20):
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return
            if done:
                return
            time.sleep(0.05)


if __name__ == "__main__":
    main()
