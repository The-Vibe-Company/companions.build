FROM companions-desktop-boundary:proof
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg procps && rm -rf /var/lib/apt/lists/*
COPY . /proof
CMD ["python3", "/proof/production.py"]
