# jvm-maven-sample

A minimal Java service on the JDK's built-in HTTP server — the smallest repo that
exercises ORCA's **JVM (Maven) recipe** (`jvm-maven`): detect `pom.xml` → synthesize a
multi-stage Dockerfile → build a jar → run it under a JRE.

```bash
orca run examples/jvm-maven-sample --dry-run
```

ORCA builds in a `maven:3.9-eclipse-temurin-21` stage (`mvn -B package`) and runs the jar
in a slim `eclipse-temurin:21-jre` image. The recipe's `{{jar}}` resolves to the built
artifact (`orca-jvm-sample.jar`). The committed
[`.orca-golden/Dockerfile`](.orca-golden/Dockerfile) is the exact synthesizer output,
pinned by a golden test.
