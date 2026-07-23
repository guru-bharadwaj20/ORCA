# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe dotnet-sdk (dotnet).
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS builder
WORKDIR /app
COPY *.csproj *.sln ./
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app/out
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 8080
CMD dotnet /app/out/orca-dotnet-sample.dll