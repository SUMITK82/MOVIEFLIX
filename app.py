import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError

from control import MovieController
from embedding_model import EmbeddingModelError, LocalEmbeddingModel
from poster_service import find_movie_poster
from service import MovieService


PROJECT_ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"


def load_environment():
    env_file = PROJECT_ROOT / ".env"
    if not env_file.is_file():
        return

    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue

        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if not name or not name.replace("_", "a").isalnum():
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        os.environ.setdefault(name, value)


class Application:
    @staticmethod
    def main():
        load_environment()
        embedding_model = LocalEmbeddingModel(
            model_name=os.environ.get(
                "EMBEDDING_MODEL",
                "sentence-transformers/all-MiniLM-L6-v2",
            ).strip(),
        )
        movie_service = MovieService(embedding_model, json, top_k=12)
        try:
            movie_service.initializeMovies()
        except EmbeddingModelError as error:
            print(
                "Movie catalog loaded, but semantic search is unavailable: "
                f"{error}"
            )
        return MovieController(movie_service)


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def create_handler(controller):
    class MovieAPIHandler(BaseHTTPRequestHandler):
        def _cors(self):
            # Allow any origin so file:// and separate ports both work.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _send_json(self, status, payload):
            body = b"" if payload is None else json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self._cors()
            if payload is not None:
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _serve_static(self, rel_path):
            # Prevent path traversal.
            target = (FRONTEND_DIR / rel_path).resolve()
            try:
                target.relative_to(FRONTEND_DIR.resolve())
            except ValueError:
                self._send_json(404, {"error": "Not found"})
                return

            if not target.is_file():
                self._send_json(404, {"error": "Not found"})
                return

            data = target.read_bytes()
            ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            path = self.path.split("?", 1)[0].rstrip("/") or "/"

            if path == "/health":
                ready = controller.movieService.is_ready
                self._send_json(
                    200,
                    {
                        "status": "ok" if ready else "degraded",
                        "catalog_count": len(
                            controller.movieService.moviesEmbedding
                        ),
                        "search_available": ready,
                    },
                )
                return

            if path == "/catalog":
                self._send_json(
                    200,
                    {
                        "count": len(controller.movieService.moviesEmbedding),
                        "movies": controller.movieService.catalog(),
                    },
                )
                return

            if path == "/poster":
                from urllib.parse import parse_qs, urlsplit

                params = parse_qs(urlsplit(self.path).query)
                title = params.get("title", [""])[0].strip()
                year_text = params.get("year", [""])[0]
                if not title or len(title) > 200:
                    self._send_json(
                        400, {"error": "'title' must be 1 to 200 characters"}
                    )
                    return
                try:
                    year = int(year_text) if year_text else None
                    if year is not None and not 1880 <= year <= 2100:
                        raise ValueError
                except ValueError:
                    self._send_json(400, {"error": "'year' must be a valid year"})
                    return
                try:
                    poster = find_movie_poster(title, year)
                except (URLError, TimeoutError, json.JSONDecodeError) as error:
                    self._send_json(
                        502, {"error": f"Wikimedia Commons lookup failed: {error}"}
                    )
                    return
                if poster is None:
                    self._send_json(404, {"error": "No matching poster found"})
                    return
                self._send_json(200, poster)
                return

            # Root and any static path → serve from frontend/ dir.
            rel = "index.html" if path == "/" else path.lstrip("/")
            self._serve_static(rel)

        def do_POST(self):
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            routes = {
                "/search": ("query", controller.search),
                "/similar": ("title", controller.similarMovies),
            }
            route = routes.get(path)
            if route is None:
                self._send_json(404, {"error": "Not found"})
                return

            if not controller.movieService.is_ready:
                self._send_json(
                    503,
                    {
                        "error": (
                            "Semantic search is temporarily unavailable because "
                            "the local embedding model is unavailable."
                        )
                    },
                )
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                if content_length <= 0 or content_length > 1_000_000:
                    self._send_json(400, {"error": "Invalid request body size"})
                    return
                payload = json.loads(self.rfile.read(content_length))
            except (ValueError, json.JSONDecodeError):
                self._send_json(400, {"error": "Request body must be valid JSON"})
                return

            field, action = route
            value = payload.get(field) if isinstance(payload, dict) else None
            if not isinstance(value, str) or not value.strip():
                self._send_json(400, {"error": f"'{field}' must be a non-empty string"})
                return

            try:
                if path == "/similar":
                    imdb_id = payload.get("imdb_id")
                    if imdb_id is not None and not isinstance(imdb_id, str):
                        self._send_json(400, {"error": "'imdb_id' must be a string"})
                        return
                    matches = action(value.strip(), imdb_id=imdb_id)
                else:
                    matches = action(value.strip())
            except ValueError as error:
                self._send_json(404, {"error": str(error)})
                return
            except (EmbeddingModelError, URLError) as error:
                self._send_json(502, {"error": str(error)})
                return

            self._send_json(
                200,
                [
                    {
                        "title": match.getTitle(),
                        "description": match.getDescription(),
                        "match": match.getMatch(),
                        "year": match.getYear(),
                        "genres": match.getGenres(),
                        "rating": match.getRating(),
                        "imdb_id": match.getImdbId(),
                        "rating_votes": match.getRatingVotes(),
                        "description_source_url": match.getDescriptionSourceUrl(),
                    }
                    for match in matches
                ],
            )

        def log_message(self, format_string, *args):
            # Keep default logging but prefix so lines are easy to spot.
            print("[http] " + (format_string % args))

    return MovieAPIHandler


def run():
    controller = Application.main()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), create_handler(controller))
    print(f"Movie search API listening on http://{host}:{port}")
    print(f"Open http://{host}:{port}/ in your browser.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()