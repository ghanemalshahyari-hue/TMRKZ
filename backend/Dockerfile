# Build context: repository root (docker build -f backend/Dockerfile .)
FROM maven:3.9.16-eclipse-temurin-25 AS build
WORKDIR /src
COPY backend/pom.xml ./pom.xml
RUN mvn -B -q dependency:go-offline
COPY backend/src ./src
RUN mvn -B -q -DskipTests package

FROM eclipse-temurin:25.0.1_8-jre-alpine
RUN addgroup -S mover && adduser -S -G mover -h /opt/mover mover \
    && mkdir -p /var/lib/mover /opt/mover/map-packages && chown -R mover:mover /var/lib/mover
COPY --from=build /src/target/mover-backend.jar /opt/mover/mover-backend.jar
COPY map-packages /opt/mover/map-packages
USER mover
EXPOSE 8080
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -Duser.timezone=UTC -Dfile.encoding=UTF-8"
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/system/health || exit 1
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /opt/mover/mover-backend.jar"]
