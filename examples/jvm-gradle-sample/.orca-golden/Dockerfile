# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe jvm-gradle (jvm).
FROM gradle:8-jdk21 AS builder
WORKDIR /app
COPY build.gradle build.gradle.kts settings.gradle ./
RUN gradle dependencies --no-daemon
COPY . .
RUN gradle bootJar --no-daemon -x test
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 8080
CMD java -jar build/libs/orca-gradle-sample.jar