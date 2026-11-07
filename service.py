import hashlib
import json
import math
import os
from pathlib import Path
import tempfile

from model.movie import Movie
from model.movie_data import MovieData
from movies_match import MoviesMatch


class MovieService:
    def __init__(self, embedding_model, json_mapper, top_k=3, cache_path=None):
        self.embeddingModel = embedding_model
        self.jsonMapper = json_mapper
        self.moviesEmbedding = []
        self.top_k = top_k
        self.is_ready = False
        self.cachePath = (
            Path(cache_path)
            if cache_path is not None
            else Path(__file__).resolve().parent / ".cache" / "movie_embeddings.json"
        )

    @staticmethod
    def _load_cached_embeddings(cache_path, signature, expected_count):
        try:
            with cache_path.open("r", encoding="utf-8") as cache_file:
                cached = json.load(cache_file)
        except (OSError, json.JSONDecodeError):
            return None

        if not isinstance(cached, dict) or cached.get("signature") != signature:
            return None
        embeddings = cached.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) != expected_count:
            return None

        dimension = None
        for embedding in embeddings:
            if not isinstance(embedding, list) or not embedding:
                return None
            if dimension is None:
                dimension = len(embedding)
            if len(embedding) != dimension or any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                for value in embedding
            ):
                return None
        return embeddings

    def _save_cached_embeddings(self, signature, embeddings):
        self.cachePath.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.cachePath.parent,
                prefix=f"{self.cachePath.name}.",
                suffix=".tmp",
                delete=False,
            ) as cache_file:
                temporary_path = Path(cache_file.name)
                json.dump(
                    {"signature": signature, "embeddings": embeddings},
                    cache_file,
                    separators=(",", ":"),
                )
                cache_file.flush()
                os.fsync(cache_file.fileno())
            os.replace(temporary_path, self.cachePath)
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()

    def initializeMovies(self):
        self.is_ready = False
        resource = Path(__file__).resolve().parent / "movies.json"

        if not resource.is_file():
            raise FileNotFoundError(f"Movie data file not found: {resource}")

        with resource.open("r", encoding="utf-8") as input_stream:
            raw_movies = self.jsonMapper.load(input_stream)

        if not isinstance(raw_movies, list):
            raise ValueError("movies.json must contain a JSON array.")

        movie_data_list = []
        for index, movie_data in enumerate(raw_movies):
            if (
                not isinstance(movie_data, dict)
                or not isinstance(movie_data.get("title"), str)
                or not isinstance(movie_data.get("description"), str)
                or movie_data.get("year") is None
                or isinstance(movie_data.get("year"), bool)
                or not isinstance(movie_data.get("year"), int)
                or not 1980 <= movie_data["year"] <= 2026
                or (
                    movie_data.get("genres") is not None
                    and (
                        not isinstance(movie_data.get("genres"), list)
                        or any(
                            not isinstance(genre, str)
                            for genre in movie_data["genres"]
                        )
                    )
                )
                or (
                    movie_data.get("rating") is not None
                    and (
                        isinstance(movie_data.get("rating"), bool)
                        or not isinstance(movie_data.get("rating"), (int, float))
                        or not 0 <= movie_data["rating"] <= 10
                    )
                )
                or (
                    movie_data.get("imdb_id") is not None
                    and (
                        not isinstance(movie_data["imdb_id"], str)
                        or not movie_data["imdb_id"].startswith("tt")
                    )
                )
                or (
                    movie_data.get("rating_votes") is not None
                    and (
                        isinstance(movie_data["rating_votes"], bool)
                        or not isinstance(movie_data["rating_votes"], int)
                        or movie_data["rating_votes"] < 0
                    )
                )
                or (
                    movie_data.get("description_source_url") is not None
                    and not isinstance(movie_data["description_source_url"], str)
                )
            ):
                raise ValueError(
                    f"Movie at index {index} must have string title and description, an integer year from 1980 to 2026, optional string genres, an optional rating from 0 to 10, an optional IMDb title ID, and an optional non-negative rating vote count."
                )
            movie_data_list.append(
                MovieData(
                    movie_data["title"],
                    movie_data["description"],
                    movie_data.get("year"),
                    movie_data.get("genres", []),
                    movie_data.get("rating"),
                    movie_data.get("imdb_id"),
                    movie_data.get("rating_votes"),
                    movie_data.get("description_source_url"),
                )
            )

        self.moviesEmbedding = [
            Movie(
                movie.getTitle(),
                movie.getDescription(),
                None,
                movie.getYear(),
                movie.getGenres(),
                movie.getRating(),
                movie.getImdbId(),
                movie.getRatingVotes(),
                movie.getDescriptionSourceUrl(),
            )
            for movie in movie_data_list
        ]
        descriptions = [
            f"{movie.getTitle()} ({movie.getYear() or 'year unknown'}). "
            f"Genres: {', '.join(movie.getGenres()) or 'Uncategorized'}. "
            f"{movie.getDescription()}"
            for movie in movie_data_list
        ]
        model_name = getattr(
            self.embeddingModel,
            "model_name",
            self.embeddingModel.__class__.__qualname__,
        )
        signature = hashlib.sha256(
            json.dumps(
                {"model": model_name, "descriptions": descriptions},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        embeddings = self._load_cached_embeddings(
            self.cachePath,
            signature,
            len(movie_data_list),
        )
        cache_hit = embeddings is not None
        if cache_hit:
            print(f"Loaded {len(embeddings)} movie embeddings from cache.")
        else:
            print(f"Creating local embeddings for {len(descriptions)} movie profiles…")
            if hasattr(self.embeddingModel, "embed_many"):
                embeddings = self.embeddingModel.embed_many(descriptions)
            else:
                embeddings = [
                    self.embeddingModel.embed(description)
                    for description in descriptions
                ]
        if len(embeddings) != len(movie_data_list):
            raise ValueError("The embedding model returned an unexpected result count.")

        if not cache_hit:
            try:
                self._save_cached_embeddings(signature, embeddings)
            except OSError as error:
                print(f"Could not save movie embedding cache: {error}")

        for movie, embedding in zip(self.moviesEmbedding, embeddings):
            movie.setEmbedding(embedding)
        self.is_ready = True
        print(f"Ready: {len(self.moviesEmbedding)} movies indexed.")

    def search(self, query):
        user_query_embedding = self.embeddingModel.embed(query)
        matches = []

        for movie in self.moviesEmbedding:
            similarity = self.cosineSimilarity(
                user_query_embedding,
                movie.getEmbedding(),
            )
            matches.append(
                MoviesMatch(
                    movie.getTitle(),
                    movie.getDescription(),
                    similarity,
                    movie.getYear(),
                    movie.getGenres(),
                    movie.getRating(),
                    movie.getImdbId(),
                    movie.getRatingVotes(),
                    movie.getDescriptionSourceUrl(),
                )
            )

        self.sortBySimilarity(matches)
        return matches

    def similarMovies(self, title, imdb_id=None):
        selected_movie = self.findMovie(title, imdb_id)
        matches = []

        for movie in self.moviesEmbedding:
            if imdb_id and movie.getImdbId() == selected_movie.getImdbId():
                continue
            if not imdb_id and movie.getTitle().lower() == title.lower():
                continue
            similarity = self.cosineSimilarity(
                selected_movie.getEmbedding(),
                movie.getEmbedding(),
            )
            matches.append(
                MoviesMatch(
                    movie.getTitle(),
                    movie.getDescription(),
                    similarity,
                    movie.getYear(),
                    movie.getGenres(),
                    movie.getRating(),
                    movie.getImdbId(),
                    movie.getRatingVotes(),
                    movie.getDescriptionSourceUrl(),
                )
            )

        self.sortBySimilarity(matches)
        return self.topKMatches(matches, self.top_k)

    def findMovie(self, title, imdb_id=None):
        if imdb_id:
            for movie in self.moviesEmbedding:
                if movie.getImdbId() == imdb_id:
                    return movie
        for movie in self.moviesEmbedding:
            if movie.getTitle().lower() == title.lower():
                return movie
        raise ValueError("Movie not found: " + title)

    def cosineSimilarity(self, a, b):
        if len(a) != len(b):
            raise ValueError("Cannot compare embeddings with different dimensions.")

        dot_product = 0.0
        norm_a = 0.0
        norm_b = 0.0

        for i in range(len(a)):
            dot_product += a[i] * b[i]
            norm_a += a[i] * a[i]
            norm_b += b[i] * b[i]

        if norm_a == 0 or norm_b == 0:
            return 0.0

        return dot_product / (math.sqrt(norm_a) * math.sqrt(norm_b))

    def sortBySimilarity(self, matches):
        matches.sort(key=lambda match: match.getMatch(), reverse=True)

    def topKMatches(self, matches, limit):
        return matches[:limit]

    def catalog(self):
        catalog = [
            {
                "title": movie.getTitle(),
                "description": movie.getDescription(),
                "year": movie.getYear(),
                "genres": movie.getGenres(),
                "rating": movie.getRating(),
                "imdb_id": movie.getImdbId(),
                "rating_votes": movie.getRatingVotes(),
                "description_source_url": movie.getDescriptionSourceUrl(),
            }
            for movie in self.moviesEmbedding
        ]
        return sorted(
            catalog,
            key=lambda movie: (
                -(movie["year"] or 0),
                movie["title"].casefold(),
            ),
        )