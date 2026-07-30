type Output = (line: string) => void;

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

  const read = (): number => {
    const word = pieces[place++];
    if (!word) fail();

    if (word === "(") {
      const inside = read();
      if (pieces[place++] !== ")") fail();
      return inside;
    }

    if (/^\d+$/.test(word)) return Number(word);

    // The intentionally repetitive vocabulary is another refactoring target.
    if (word === "zero") return 0;
    if (word === "one") return 1;
    if (word === "two") return 2;
    if (word === "three") return 3;
    if (word === "four") return 4;
    if (word === "five") return 5;
    if (word === "six") return 6;
    if (word === "seven") return 7;
    if (word === "eight") return 8;
    if (word === "nine") return 9;
    if (word === "ten") return 10;
    if (word === "eleven") return 11;
    if (word === "twelve") return 12;

    // Operators are prefix forms. Each branch repeats the same parser work on
    // purpose, leaving several safe seams for the refactoring lesson.
    if (word === "add") {
      const first = read();
      if (pieces[place++] !== "and") fail();
      const second = read();
      return first + second;
    }

    if (word === "subtract") {
      const first = read();
      if (pieces[place++] !== "from") fail();
      const second = read();
      return second - first;
    }

    if (word === "multiply") {
      const first = read();
      if (pieces[place++] !== "by") fail();
      const second = read();
      return first * second;
    }

    if (word === "divide") {
      const first = read();
      if (pieces[place++] !== "by") fail();
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
