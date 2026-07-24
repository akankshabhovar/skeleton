#!/bin/bash
if [ -d "/solution" ]; then
  # Inside the Docker container (grading environment)
  mkdir -p /app/publisher
  cp /solution/publisher/release-publisher.mjs /app/publisher/release-publisher.mjs
else
  # Local host environment (Windows/development)
  mkdir -p environment/publisher
  cp solution/publisher/release-publisher.mjs environment/publisher/release-publisher.mjs
fi
