'use client';

import { useState } from 'react';

interface QuizStep {
  readonly q: string;
  readonly options: readonly string[];
}

const QUIZ_STEPS: readonly QuizStep[] = [
  {
    q: 'Who are you building this plan for?',
    options: ['My parent', 'My partner', 'A grandparent', 'Myself'],
  },
  {
    q: 'What feels most urgent right now?',
    options: [
      'Better daily meals',
      'Companionship & connection',
      'Help with everyday tasks',
      'A bit of everything',
    ],
  },
  {
    q: 'How often should someone be in the home?',
    options: [
      'Once a week',
      '2 — 3 times a week',
      'Most days',
      'I’m not sure yet — help me decide',
    ],
  },
];

export function Quiz(): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<ReadonlyArray<string | null>>([null, null, null]);
  const [done, setDone] = useState(false);
  const total = QUIZ_STEPS.length;
  const current = QUIZ_STEPS[step];

  const choose = (opt: string): void => {
    const next = [...answers];
    next[step] = opt;
    setAnswers(next);
    setTimeout(() => {
      if (step < total - 1) setStep(step + 1);
      else setDone(true);
    }, 220);
  };

  const reset = (): void => {
    setStep(0);
    setAnswers([null, null, null]);
    setDone(false);
  };

  return (
    <section id="quiz" className="section weave" style={{ background: 'var(--linen)' }}>
      <div className="wrap" style={{ maxWidth: 880 }}>
        <div className="text-center">
          <div className="eyebrow" style={{ justifyContent: 'center' }}>
            Build your plan · 3 questions
          </div>
          <h2 className="h2 mt-4">
            Three questions,{' '}
            <span className="serif-i" style={{ color: 'var(--clay)' }}>
              two minutes,
            </span>{' '}
            a real plan.
          </h2>
        </div>

        <div className="card mt-12" style={{ padding: 40, background: 'var(--paper)' }}>
          {!done && current !== undefined ? (
            <>
              <div className="flex justify-between" style={{ alignItems: 'center' }}>
                <span className="mono" style={{ color: 'var(--clay)' }}>
                  Question {step + 1} of {total}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {QUIZ_STEPS.map((_, i) => (
                    <span
                      // eslint-disable-next-line react/no-array-index-key -- step indicators are positional
                      key={i}
                      style={{
                        width: 32,
                        height: 3,
                        background: i <= step ? 'var(--espresso)' : 'var(--rule)',
                        borderRadius: 999,
                        transition: 'background 0.3s ease',
                      }}
                    />
                  ))}
                </div>
              </div>
              <h3
                className="serif mt-6"
                style={{
                  fontSize: 32,
                  color: 'var(--espresso)',
                  fontWeight: 300,
                  lineHeight: 1.15,
                }}
              >
                {current.q}
              </h3>
              <div className="mt-8" style={{ display: 'grid', gap: 10 }}>
                {current.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => choose(opt)}
                    className={`quiz-option ${answers[step] === opt ? 'selected' : ''}`}
                  >
                    <span>{opt}</span>
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>→</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div>
              <div className="mono" style={{ color: 'var(--clay)' }}>
                Your starting point
              </div>
              <h3
                className="serif mt-4"
                style={{ fontSize: 36, color: 'var(--espresso)', fontWeight: 300 }}
              >
                The{' '}
                <span className="serif-i" style={{ color: 'var(--clay)' }}>
                  Table
                </span>{' '}
                plan looks right for you.
              </h3>
              <p className="lead mt-6">
                Two chef visits, one weekly companion lunch, and a few hours of concierge support.
                Most families on this plan find their loved one eats more, sleeps better, and asks
                about Tuesday by Sunday night. We’ll match your team within 48 hours.
              </p>
              <div className="quiz-recap">
                {answers.map((a, i) => (
                  <div
                    // eslint-disable-next-line react/no-array-index-key -- positional answer
                    key={i}
                    style={{ borderTop: '1px solid var(--rule)', paddingTop: 12 }}
                  >
                    <div className="mono" style={{ color: 'var(--ink-soft)' }}>
                      Q{i + 1}
                    </div>
                    <div className="serif mt-2" style={{ fontSize: 17, color: 'var(--espresso)' }}>
                      {a ?? '—'}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-3 mt-8" style={{ flexWrap: 'wrap' }}>
                <input
                  type="email"
                  placeholder="your@email.com"
                  aria-label="Email address"
                  style={{ flex: 1, minWidth: 220 }}
                />
                <button type="button" className="btn btn-primary btn-arrow">
                  Schedule discovery call
                </button>
                <button type="button" className="btn btn-ghost" onClick={reset}>
                  Start over
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
