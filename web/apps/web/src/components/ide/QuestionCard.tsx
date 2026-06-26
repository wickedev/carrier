import * as React from "react";
import { Button } from "@carrier/ui";
import { MessageCircleQuestion } from "lucide-react";
import { Card, CardHeader } from "../primitives";
import type { PendingQuestion } from "../../session/stream";

/**
 * ask_user question card. Renders the agent's prompt plus any suggested choices
 * as quick-answer buttons, and a free-text field so the user may answer in their
 * own words. The answer is correlated back to the blocked tool by `reqId`.
 */
export function QuestionCard({
  question,
  onAnswer,
  pending,
}: {
  question: PendingQuestion;
  onAnswer: (reqId: string, answer: string) => void;
  pending?: boolean;
}) {
  const [text, setText] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Focus the free-text field on mount so the user can type or tab to choices.
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed || pending) return;
    onAnswer(question.reqId, trimmed);
  };

  return (
    <Card
      className="mx-3 my-2 border-accent"
      role="dialog"
      aria-label="Agent question"
      data-testid="question-card"
    >
      <CardHeader
        tone="amber"
        icon={<MessageCircleQuestion className="h-4 w-4" aria-hidden />}
      >
        Question
      </CardHeader>
      <div className="space-y-2 px-3 py-2 text-sm">
        <p className="whitespace-pre-wrap">{question.prompt}</p>
        {question.choices.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {question.choices.map((choice, i) => (
              <Button
                key={i}
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => submit(choice)}
              >
                {choice}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <form
        className="flex items-center gap-2 px-3 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={text}
          disabled={pending}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your answer…"
          className="flex-1 rounded border border-line bg-bg px-2 py-1 text-sm outline-none focus:border-accent"
          data-testid="question-input"
        />
        <Button size="sm" type="submit" disabled={pending || !text.trim()}>
          Answer
        </Button>
      </form>
    </Card>
  );
}
