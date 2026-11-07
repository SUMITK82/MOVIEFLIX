class EmbeddingModelError(RuntimeError):
    pass


class LocalEmbeddingModel:
    def __init__(self, model_name="sentence-transformers/all-MiniLM-L6-v2"):
        if not model_name:
            raise ValueError("An embedding model name is required.")

        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as error:
            raise EmbeddingModelError(
                "Sentence Transformers is not installed. Install project "
                "dependencies with: uv pip install --python .venv/bin/python "
                "-r requirements.txt"
            ) from error

        self.model_name = model_name
        self.model = SentenceTransformer(model_name)

    def embed(self, text):
        return self.model.encode(
            text,
            convert_to_numpy=True,
            normalize_embeddings=True,
        ).tolist()

    def embed_many(self, texts):
        if not texts:
            return []

        embeddings = self.model.encode(
            texts,
            batch_size=32,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=len(texts) > 32,
        )
        return embeddings.tolist()
