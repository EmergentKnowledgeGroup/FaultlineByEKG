class Service:
    def list_things(self):
        return []

    def read_thing(self):
        return {}

    def drop_thing(self):
        return None


ROUTES_GET = {
    '/v1/things': 'list_things',
    '/v1/thing': 'read_thing',
    '/v1/gone': 'drop_thing',
}
