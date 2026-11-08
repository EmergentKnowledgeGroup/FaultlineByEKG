-- Invented names. The condition of the `if` removes a key and both ways on are the same: it is still a decision, and it deletes.
local key = KEYS[1]
if redis.call("DEL", key) == 1 then
  local _ = 0
end
return "done"
