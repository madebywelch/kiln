FROM golang:1.27.2-bookworm AS source
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .

FROM source AS test
RUN test -z "$(gofmt -l cmd internal)" && go vet ./... && go test -race -count=1 -timeout 120s ./...

FROM source AS build
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/kiln ./cmd/kiln && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/kiln /usr/local/bin/kiln
COPY --from=build --chown=nonroot:nonroot /out/data /data
ENV KILN_DATA=/data KILN_ADDR=0.0.0.0:8080
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["kiln"]
