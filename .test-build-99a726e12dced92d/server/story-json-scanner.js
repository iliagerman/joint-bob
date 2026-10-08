function createTopLevelFieldScanner(onField) {
  let index = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expectKey = false;
  let keyStart = -1;
  let key = "";
  let valueStart = -1;
  const finish = (text, end) => {
    if (valueStart < 0 || !key) return;
    const raw = text.slice(valueStart, end).trim();
    valueStart = -1;
    try {
      onField(key, JSON.parse(raw));
    } catch {
    }
  };
  return (text) => {
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          inString = false;
          if (depth === 1 && keyStart >= 0) {
            try {
              key = JSON.parse(text.slice(keyStart, index + 1));
            } catch {
              key = "";
            }
            keyStart = -1;
          } else if (depth === 1) finish(text, index + 1);
        }
        continue;
      }
      if (depth === 0) {
        if (char === "{") {
          depth = 1;
          expectKey = true;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        if (depth === 1 && expectKey) {
          keyStart = index;
          expectKey = false;
        } else if (depth === 1 && valueStart < 0) valueStart = index;
      } else if (char === "{" || char === "[") {
        if (depth === 1 && valueStart < 0) valueStart = index;
        depth += 1;
      } else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 1) finish(text, index + 1);
        else if (depth === 0) {
          finish(text, index);
          return;
        }
      } else if (depth === 1 && char === ":") {
        valueStart = -1;
      } else if (depth === 1 && char === ",") {
        finish(text, index);
        expectKey = true;
      } else if (depth === 1 && valueStart < 0 && !/\s/.test(char)) {
        valueStart = index;
      }
    }
  };
}
export {
  createTopLevelFieldScanner
};
