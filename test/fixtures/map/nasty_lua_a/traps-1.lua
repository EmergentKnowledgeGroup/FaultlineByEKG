--[[ traps ]]
local rcall = redis.call
local key = KEYS[1]

-- L1: error() ends the script
if ARGV[1] == "a" then
  rcall("SET", key, 1)
  error("stop")
end
rcall("DEL", key)

-- L2: redis.error_reply is only a value; return ends
if ARGV[2] == "b" then
  rcall("SET", key, 2)
  return redis.error_reply("nope")
end

-- L3: pcall swallows the error inside
local ok, err = pcall(function() error("inner") end)
if not ok then rcall("HSET", key, "e", tostring(err)) end

-- L4: a read-only redis call
local v = rcall("GET", key)
if v then
  return v
end

-- L5: dead branch
if false then
  rcall("DEL", key)
end

-- L6: commands in a variable
local cmd = ARGV[3]
rcall(cmd, key)

-- L7: assert raises
assert(ARGV[4] ~= nil, "must")
rcall("EXPIRE", key, 10)

-- L8: goto skipping
for i = 1, 3 do
  if i == 2 then goto continue end
  rcall("LPUSH", key, i)
  ::continue::
end
return 0
