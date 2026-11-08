local key = KEYS[1]
if redis.call("EXISTS", key) == 0 then
  return -1
end
redis.call("SET", key, "stamped")
return 1
