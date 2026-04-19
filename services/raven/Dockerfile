FROM eclipse-temurin:24-jdk AS builder

WORKDIR /workspace/services/raven

COPY services/raven/gradle ./gradle
COPY services/raven/gradlew ./gradlew
COPY services/raven/gradlew.bat ./gradlew.bat
COPY services/raven/build.gradle ./build.gradle
COPY services/raven/settings.gradle ./settings.gradle

RUN sed -i 's/\r$//' ./gradlew && chmod +x ./gradlew
RUN ./gradlew --no-daemon dependencies > /dev/null

COPY services/raven/src ./src

RUN ./gradlew --no-daemon bootJar

FROM eclipse-temurin:24-jre

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl openvpn iproute2 unzip \
  && rm -rf /var/lib/apt/lists/*

ENV SERVER_PORT=8080
ENV SCRIPTARR_RAVEN_DATA_ROOT=/downloads

COPY --from=builder /workspace/services/raven/build/libs/*.jar /app/app.jar

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD curl -fsS http://localhost:8080/health > /dev/null || exit 1

CMD ["java", "-jar", "/app/app.jar"]

