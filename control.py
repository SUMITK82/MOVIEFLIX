class MovieController:
    def __init__(self, movie_service):
        self.movieService = movie_service

    def search(self, query):
        return self.movieService.search(query)

    def similarMovies(self, title, imdb_id=None):
        return self.movieService.similarMovies(title, imdb_id)