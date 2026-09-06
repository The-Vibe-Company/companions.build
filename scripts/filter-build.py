"""Pre-fetch the immutable Linux image used as the trigger-filter security boundary."""
import subprocess

IMAGE = "node:22.20.0-alpine3.22@sha256:dbcedd8aeab47fbc0f4dd4bffa55b7c3c729a707875968d467aaaea42d6225af"
subprocess.run(["docker", "pull", IMAGE], check=True)
