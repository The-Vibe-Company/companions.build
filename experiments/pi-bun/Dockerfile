FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
# The tested runtime has a shell and core utilities, but no package manager.
# All mutations here affect the disposable image, never the developer host.
RUN rm -f /usr/bin/apt* /usr/bin/dpkg* /usr/sbin/dpkg* /usr/bin/debconf*
ENV HOME=/state/home
WORKDIR /state
