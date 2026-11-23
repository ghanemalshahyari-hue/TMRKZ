# Build context: repository root (docker build -f backend/Dockerfile .)
FROM maven:3.9.16-eclipse-temurin-25 AS build
WORKDIR /src
COPY backend/pom.xml ./pom.xml
RUN mvn -B -q dependency:go-offline
COPY backend/src ./src
RUN mvn -B -q -DskipTests package

FROM eclipse-temurin:25.0.1_8-jre-alpine
RUN addgroup -S tmrkz && adduser -S -G tmrkz -h /opt/tmrkz tmrkz \
    && mkdir -p /var/lib/tmrkz /opt/tmrkz/map-packages && chown -R tmrkz:tmrkz /var/lib/tmrkz
COPY --from=build /src/target/mover-backend.jar /opt/tmrkz/tmrkz-backend.jar
COPY map-packages /opt/tmrkz/map-packages
USER tmrkz
EXPOSE 8080
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -Duser.timezone=UTC -Dfile.encoding=UTF-8"
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/system/health || exit 1
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /opt/tmrkz/tmrkz-backend.jar"]
