# jvm-gradle-sample

A minimal Java service on the JDK's built-in HTTP server, built with **Gradle** — the
smallest repo that exercises ORCA's **JVM (Gradle) recipe** (`jvm-gradle`): detect
`build.gradle` → synthesize a multi-stage Dockerfile → build a jar → run under a JRE.

```bash
orca run examples/jvm-gradle-sample --dry-run
```

ORCA builds in a `gradle:8-jdk21` stage (`gradle bootJar`) and runs the jar in a slim
`eclipse-temurin:21-jre` image. The recipe's `{{jar}}` resolves to the built artifact
(`orca-gradle-sample.jar`). The committed
[`.orca-golden/Dockerfile`](.orca-golden/Dockerfile) is the exact synthesizer output,
pinned by a golden test.
