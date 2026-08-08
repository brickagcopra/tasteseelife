import { describe, expect, it } from 'vitest';

import {
  ActivateTemplateVersionRequestSchema,
  CreateTemplateRequestSchema,
  CreateTemplateVersionRequestSchema,
  ListTemplatesQuerySchema,
  NOTIFICATION_BODY_MJML_MAX_LENGTH,
  NOTIFICATION_BODY_TEXT_MAX_LENGTH,
  NOTIFICATION_LIST_LIMIT_DEFAULT,
  NOTIFICATION_LIST_LIMIT_MAX,
  NOTIFICATION_SUBJECT_MAX_LENGTH,
  NOTIFICATION_TEMPLATE_NAME_MAX_LENGTH,
  NOTIFICATION_VARIABLES_MAX_ENTRIES,
  NotificationChannelKindSchema,
  NotificationLocaleSchema,
  NotificationVariableEntrySchema,
  NotificationVariableTypeSchema,
  RenderTemplateRequestSchema,
  RenderTemplateResponseSchema,
  TemplateResponseSchema,
  TemplateVersionResponseSchema,
  TemplateVersionsListResponseSchema,
  TemplatesListResponseSchema,
} from '../http';

describe('NotificationChannelKindSchema', () => {
  it('accepts every Phase-1 channel', () => {
    (['email', 'sms', 'push', 'in_app'] as const).forEach((value) => {
      expect(NotificationChannelKindSchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects an unknown channel', () => {
    expect(NotificationChannelKindSchema.safeParse('telegram').success).toBe(false);
  });
});

describe('NotificationVariableTypeSchema', () => {
  it('accepts the three JSON-safe primitive types', () => {
    (['string', 'number', 'boolean'] as const).forEach((value) => {
      expect(NotificationVariableTypeSchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects object / array shapes', () => {
    expect(NotificationVariableTypeSchema.safeParse('object').success).toBe(false);
    expect(NotificationVariableTypeSchema.safeParse('array').success).toBe(false);
  });
});

describe('NotificationLocaleSchema', () => {
  it('accepts the Phase-1 + Phase-2 locale set', () => {
    (['en-US', 'es-US', 'zh-CN'] as const).forEach((value) => {
      expect(NotificationLocaleSchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects an unsupported locale', () => {
    expect(NotificationLocaleSchema.safeParse('fr-FR').success).toBe(false);
  });
});

describe('NotificationVariableEntrySchema', () => {
  it('accepts a fully-populated entry', () => {
    const entry = {
      name: 'firstName',
      type: 'string' as const,
      required: true,
      description: 'The recipient first name.',
    };
    expect(NotificationVariableEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('rejects a variable name with a leading digit', () => {
    expect(
      NotificationVariableEntrySchema.safeParse({
        name: '1firstName',
        type: 'string',
        required: true,
      }).success,
    ).toBe(false);
  });

  it('rejects a variable name with a hyphen', () => {
    expect(
      NotificationVariableEntrySchema.safeParse({
        name: 'first-name',
        type: 'string',
        required: true,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(
      NotificationVariableEntrySchema.safeParse({
        name: 'firstName',
        type: 'string',
        required: true,
        defaultValue: 'Alice',
      }).success,
    ).toBe(false);
  });
});

describe('CreateTemplateRequestSchema', () => {
  const baseBody = {
    code: 'welcome.family.tier_2',
    locale: 'en-US' as const,
    kind: 'email' as const,
    name: 'Welcome email — Tier 2 family',
    description: 'Sent on first successful Tier 2 subscription activation.',
  };

  it('accepts a fully-populated body', () => {
    expect(CreateTemplateRequestSchema.safeParse(baseBody).success).toBe(true);
  });

  it('accepts a body without a description', () => {
    const { description: _omit, ...rest } = baseBody;
    expect(CreateTemplateRequestSchema.safeParse(rest).success).toBe(true);
  });

  it('rejects an empty code', () => {
    expect(CreateTemplateRequestSchema.safeParse({ ...baseBody, code: '' }).success).toBe(false);
  });

  it('rejects a code with disallowed characters', () => {
    expect(
      CreateTemplateRequestSchema.safeParse({ ...baseBody, code: 'welcome family' }).success,
    ).toBe(false);
  });

  it('rejects a code that ends with a separator', () => {
    expect(CreateTemplateRequestSchema.safeParse({ ...baseBody, code: 'welcome.' }).success).toBe(
      false,
    );
  });

  it('rejects a name longer than the cap', () => {
    expect(
      CreateTemplateRequestSchema.safeParse({
        ...baseBody,
        name: 'x'.repeat(NOTIFICATION_TEMPLATE_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(CreateTemplateRequestSchema.safeParse({ ...baseBody, extraField: 'oops' }).success).toBe(
      false,
    );
  });
});

describe('CreateTemplateVersionRequestSchema', () => {
  it('accepts an email-shaped version with MJML + subject', () => {
    const body = {
      subject: 'Welcome to Taste & See',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{firstName}}</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [{ name: 'firstName', type: 'string' as const, required: true }],
      activate: true,
    };
    expect(CreateTemplateVersionRequestSchema.safeParse(body).success).toBe(true);
  });

  it('accepts an SMS-shaped version with bodyText only', () => {
    const body = {
      bodyText: 'Your verification code is {{code}}.',
      variablesSchema: [{ name: 'code', type: 'string' as const, required: true }],
    };
    expect(CreateTemplateVersionRequestSchema.safeParse(body).success).toBe(true);
  });

  it('accepts an empty variables schema', () => {
    const body = {
      bodyText: 'Hello!',
      variablesSchema: [],
    };
    expect(CreateTemplateVersionRequestSchema.safeParse(body).success).toBe(true);
  });

  it('rejects duplicate variable names', () => {
    const body = {
      bodyText: 'Hi {{firstName}}',
      variablesSchema: [
        { name: 'firstName', type: 'string' as const, required: true },
        { name: 'firstName', type: 'string' as const, required: false },
      ],
    };
    expect(CreateTemplateVersionRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects too many variables', () => {
    const variables = Array.from({ length: NOTIFICATION_VARIABLES_MAX_ENTRIES + 1 }, (_, i) => ({
      name: `var_${i}`,
      type: 'string' as const,
      required: false,
    }));
    const body = {
      bodyText: 'No vars used.',
      variablesSchema: variables,
    };
    expect(CreateTemplateVersionRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an MJML body above the cap', () => {
    const body = {
      subject: 'Test',
      bodyMjml: 'x'.repeat(NOTIFICATION_BODY_MJML_MAX_LENGTH + 1),
      variablesSchema: [],
    };
    expect(CreateTemplateVersionRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a subject above the cap', () => {
    const body = {
      subject: 'x'.repeat(NOTIFICATION_SUBJECT_MAX_LENGTH + 1),
      bodyMjml: '<mjml />',
      variablesSchema: [],
    };
    expect(CreateTemplateVersionRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a body text above the cap', () => {
    const body = {
      bodyText: 'x'.repeat(NOTIFICATION_BODY_TEXT_MAX_LENGTH + 1),
      variablesSchema: [],
    };
    expect(CreateTemplateVersionRequestSchema.safeParse(body).success).toBe(false);
  });

  it('defaults activate to false', () => {
    const result = CreateTemplateVersionRequestSchema.safeParse({
      bodyText: 'Hi',
      variablesSchema: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activate).toBe(false);
    }
  });
});

describe('TemplateResponseSchema', () => {
  it('round-trips a fully-populated response', () => {
    const response = {
      id: 'tpl_001',
      code: 'welcome.family.tier_2',
      locale: 'en-US' as const,
      kind: 'email' as const,
      name: 'Welcome',
      description: 'desc',
      activeVersionId: 'ver_001',
      activeVersionNumber: 1,
      latestVersionNumber: 1,
      createdByUserId: 'user_001',
      createdAt: '2026-05-16T12:00:00.000Z',
      updatedAt: '2026-05-16T12:05:00.000Z',
    };
    expect(TemplateResponseSchema.safeParse(response).success).toBe(true);
  });

  it('accepts a template with no active version yet', () => {
    const response = {
      id: 'tpl_001',
      code: 'welcome.family.tier_2',
      locale: 'en-US' as const,
      kind: 'email' as const,
      name: 'Welcome',
      description: null,
      activeVersionId: null,
      activeVersionNumber: null,
      latestVersionNumber: null,
      createdByUserId: 'user_001',
      createdAt: '2026-05-16T12:00:00.000Z',
      updatedAt: '2026-05-16T12:00:00.000Z',
    };
    expect(TemplateResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe('TemplateVersionResponseSchema', () => {
  it('round-trips an SMS version with null email-only fields', () => {
    const version = {
      id: 'ver_001',
      templateId: 'tpl_001',
      version: 3,
      subject: null,
      bodyMjml: null,
      bodyHtml: null,
      bodyText: 'Your code is {{code}}.',
      variablesSchema: [{ name: 'code', type: 'string' as const, required: true }],
      isActive: true,
      changeSummary: null,
      createdByUserId: 'user_001',
      createdAt: '2026-05-16T12:00:00.000Z',
    };
    expect(TemplateVersionResponseSchema.safeParse(version).success).toBe(true);
  });

  it('round-trips an email version', () => {
    const version = {
      id: 'ver_001',
      templateId: 'tpl_001',
      version: 1,
      subject: 'Welcome',
      bodyMjml: '<mjml />',
      bodyHtml: '<html />',
      bodyText: null,
      variablesSchema: [],
      isActive: false,
      changeSummary: 'Initial version.',
      createdByUserId: 'user_001',
      createdAt: '2026-05-16T12:00:00.000Z',
    };
    expect(TemplateVersionResponseSchema.safeParse(version).success).toBe(true);
  });
});

describe('TemplateVersionsListResponseSchema', () => {
  it('round-trips an empty list', () => {
    expect(TemplateVersionsListResponseSchema.safeParse({ versions: [] }).success).toBe(true);
  });
});

describe('ListTemplatesQuerySchema', () => {
  it('applies the default limit when omitted', () => {
    const result = ListTemplatesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(NOTIFICATION_LIST_LIMIT_DEFAULT);
    }
  });

  it('coerces a string limit', () => {
    const result = ListTemplatesQuerySchema.safeParse({ limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });

  it('rejects a limit above the cap', () => {
    expect(
      ListTemplatesQuerySchema.safeParse({ limit: NOTIFICATION_LIST_LIMIT_MAX + 1 }).success,
    ).toBe(false);
  });

  it('accepts kind / locale / code filters', () => {
    const result = ListTemplatesQuerySchema.safeParse({
      kind: 'email',
      locale: 'en-US',
      code: 'welcome.family.tier_2',
    });
    expect(result.success).toBe(true);
  });
});

describe('TemplatesListResponseSchema', () => {
  it('round-trips an empty list with no cursor', () => {
    expect(TemplatesListResponseSchema.safeParse({ templates: [], nextCursor: null }).success).toBe(
      true,
    );
  });
});

describe('RenderTemplateRequestSchema', () => {
  it('accepts a body with string + number + boolean variables', () => {
    const body = {
      templateCode: 'welcome.family.tier_2',
      locale: 'en-US' as const,
      variables: {
        firstName: 'Alice',
        outstandingBalance: 0,
        emailVerified: true,
      },
    };
    expect(RenderTemplateRequestSchema.safeParse(body).success).toBe(true);
  });

  it('accepts a body without variables', () => {
    expect(
      RenderTemplateRequestSchema.safeParse({
        templateCode: 'welcome.family.tier_2',
        locale: 'en-US',
      }).success,
    ).toBe(true);
  });

  it('rejects a variable name with disallowed characters', () => {
    expect(
      RenderTemplateRequestSchema.safeParse({
        templateCode: 'x',
        locale: 'en-US',
        variables: { 'first-name': 'Alice' },
      }).success,
    ).toBe(false);
  });

  it('rejects a variable map above the entry cap', () => {
    const variables: Record<string, string> = {};
    for (let i = 0; i <= NOTIFICATION_VARIABLES_MAX_ENTRIES; i += 1) {
      variables[`var_${i}`] = 'x';
    }
    expect(
      RenderTemplateRequestSchema.safeParse({
        templateCode: 'x',
        locale: 'en-US',
        variables,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-finite number variable', () => {
    expect(
      RenderTemplateRequestSchema.safeParse({
        templateCode: 'x',
        locale: 'en-US',
        variables: { count: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
  });
});

describe('RenderTemplateResponseSchema', () => {
  it('round-trips an email render', () => {
    const response = {
      templateCode: 'welcome.family.tier_2',
      locale: 'en-US' as const,
      kind: 'email' as const,
      version: 3,
      subject: 'Welcome, Alice',
      bodyHtml: '<html><body>Hi Alice</body></html>',
      bodyText: 'Hi Alice',
    };
    expect(RenderTemplateResponseSchema.safeParse(response).success).toBe(true);
  });

  it('round-trips an SMS render with nulls for email-only fields', () => {
    const response = {
      templateCode: 'mfa.code.sms',
      locale: 'en-US' as const,
      kind: 'sms' as const,
      version: 1,
      subject: null,
      bodyHtml: null,
      bodyText: 'Your code is 123456.',
    };
    expect(RenderTemplateResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe('ActivateTemplateVersionRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(ActivateTemplateVersionRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts an optional reason', () => {
    expect(ActivateTemplateVersionRequestSchema.safeParse({ reason: 'pilot' }).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(ActivateTemplateVersionRequestSchema.safeParse({ extraField: 'oops' }).success).toBe(
      false,
    );
  });
});
