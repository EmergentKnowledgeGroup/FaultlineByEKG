local key = KEYS[1]
redis.call("SET", key, ARGV[1])
return 1
