type Output = (line: string) => void;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Evaluate the kata's tiny spoken-expression language.
 *
 * This is intentionally a single, inconvenient starting point for the kata:
 * it tokenises, parses, performs arithmetic, formats results, and knows about
 * command-line output. The behaviour is covered; the structure is not a model
 * to emulate.
 */
export function evaluateSpokenExpression(source: string): number {
  const pieces = source
    .toLowerCase()
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let place = 0;

  const fail = (): never => {
    // Deliberately unhelpful starter error: a later kata step improves this.
    throw new Error("Could not work that out.");
  };

  const consume = (expected: string): void => {
    if (pieces[place++] !== expected) fail();
  };

  const read = (): number => {
    const word = pieces[place++];
    if (!word) fail();

    if (word === "(") {
      const inside = read();
      consume(")");
      return inside;
    }

    if (/^\d+$/.test(word)) return Number(word);

    const numberWord = NUMBER_WORDS[word];
    if (numberWord !== undefined) return numberWord;

    // Operators are prefix forms. Each branch repeats the same parser work on
    // purpose, leaving several safe seams for the refactoring lesson.
    if (word === "add") {
      const first = read();
      consume("and");
      const second = read();
      return first + second;
    }

    if (word === "subtract") {
      const first = read();
      consume("from");
      const second = read();
      return second - first;
    }

    if (word === "multiply") {
      const first = read();
      consume("by");
      const second = read();
      return first * second;
    }

    if (word === "divide") {
      const first = read();
      consume("by");
      const second = read();
      if (second === 0) fail();
      return first / second;
    }

    return fail();
  };

  const answer = read();
  if (place !== pieces.length) fail();
  return answer;
}

export function formatAnswer(answer: number): string {
  return `Result: ${answer}`;
}

/** Run the command-line behaviour without making tests replace process.exit. */
export function runCli(args: string[], write: Output, writeError: Output): number {
  if (args.length === 0) {
    writeError("Give me a spoken expression to calculate.");
    return 1;
  }

  try {
    write(formatAnswer(evaluateSpokenExpression(args.join(" "))));
    return 0;
  } catch {
    writeError("Unable to calculate that expression.");
    return 1;
  }
}
