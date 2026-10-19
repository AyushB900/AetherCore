# syntax=docker/dockerfile:1
FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml .
RUN --mount=type=secret,id=maven_settings,target=/root/.m2/settings.xml \
    --mount=type=secret,id=java_truststore,target=/tmp/cloud-cacerts \
    if [ -f /tmp/cloud-cacerts ]; then export MAVEN_OPTS="-Djavax.net.ssl.trustStore=/tmp/cloud-cacerts"; fi; \
    mvn -B dependency:go-offline
COPY src src
RUN --mount=type=secret,id=maven_settings,target=/root/.m2/settings.xml \
    --mount=type=secret,id=java_truststore,target=/tmp/cloud-cacerts \
    if [ -f /tmp/cloud-cacerts ]; then export MAVEN_OPTS="-Djavax.net.ssl.trustStore=/tmp/cloud-cacerts"; fi; \
    mvn -B package -DskipTests
FROM eclipse-temurin:21-jre
WORKDIR /app
RUN groupadd --system aether && useradd --system --gid aether aether
COPY --from=build /build/target/aethercore-0.1.0.jar app.jar
COPY --chown=aether:aether site /app/site
USER aether
EXPOSE 8080
ENTRYPOINT ["java","-jar","app.jar"]
