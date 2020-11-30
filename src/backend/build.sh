#!/bin/sh

./gradlew build
docker build --build-arg JAR_FILE=build/libs/*.jar -t unicorn.dev/email-backend:latest .
