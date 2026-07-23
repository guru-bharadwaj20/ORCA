# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe jvm-maven (jvm).
FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /app
COPY pom.xml ./
RUN mvn -B dependency:go-offline
COPY . .
RUN mvn -B package -DskipTests
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 8080
CMD java -jar target/orca-jvm-sample.jar