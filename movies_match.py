class MoviesMatch:
    def __init__(
        self,
        title=None,
        description=None,
        match=0.0,
        year=None,
        genres=None,
        rating=None,
        imdb_id=None,
        rating_votes=None,
        description_source_url=None,
    ):
        self.title = title
        self.description = description
        self.match = match
        self.year = year
        self.genres = genres or []
        self.rating = rating
        self.imdb_id = imdb_id
        self.rating_votes = rating_votes
        self.description_source_url = description_source_url

    def getTitle(self):
        return self.title

    def setTitle(self, title):
        self.title = title

    def getDescription(self):
        return self.description

    def setDescription(self, description):
        self.description = description

    def getMatch(self):
        return self.match

    def setMatch(self, match):
        self.match = match

    def getYear(self):
        return self.year

    def setYear(self, year):
        self.year = year

    def getGenres(self):
        return self.genres

    def setGenres(self, genres):
        self.genres = genres

    def getRating(self):
        return self.rating

    def setRating(self, rating):
        self.rating = rating

    def getImdbId(self):
        return self.imdb_id

    def getRatingVotes(self):
        return self.rating_votes

    def getDescriptionSourceUrl(self):
        return self.description_source_url