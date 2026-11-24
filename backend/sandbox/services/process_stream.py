"""Read incremental process output, including carriage-return Git progress."""
import codecs


def process_output(stdout, secret=""):
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    pending = ""
    keep = max(0, len(secret) - 1)

    def chunks():
        if hasattr(stdout, "read1"):
            while True:
                chunk = stdout.read1(4096)
                if not chunk:
                    return
                yield chunk
        else:
            yield from stdout

    for chunk in chunks():
        pending += decoder.decode(chunk) if isinstance(chunk, bytes) else str(chunk)
        if secret:
            pending = pending.replace(secret, "******")
        ready = len(pending) - keep
        if ready > 0:
            yield pending[:ready]
            pending = pending[ready:]
    pending += decoder.decode(b"", final=True)
    if secret:
        pending = pending.replace(secret, "******")
    if pending:
        yield pending
