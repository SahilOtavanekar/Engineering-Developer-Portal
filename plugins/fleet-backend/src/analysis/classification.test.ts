import { classifyRepository, type ClassificationInput } from './classification';

function input(
  overrides: Partial<ClassificationInput> = {},
): ClassificationInput {
  return {
    techStack: [],
    hasPipelineRuns: false,
    environmentTypes: [],
    ...overrides,
  };
}

describe('classifyRepository — type', () => {
  it('calls a front end a website', () => {
    expect(classifyRepository(input({ techStack: ['React'] })).type).toBe(
      'website',
    );
    expect(classifyRepository(input({ techStack: ['Angular'] })).type).toBe(
      'website',
    );
    expect(classifyRepository(input({ techStack: ['Next.js'] })).type).toBe(
      'website',
    );
  });

  it('keeps a containerised front end a website', () => {
    // Most front ends in this estate also carry Docker. Letting Docker win
    // would classify every one of them as a service.
    const result = classifyRepository(
      input({
        techStack: ['React', 'TypeScript', 'Docker', 'Node.js'],
        hasPipelineRuns: true,
        environmentTypes: ['Test', 'Production'],
      }),
    );

    expect(result.type).toBe('website');
  });

  it('calls a containerised or serverless thing a service', () => {
    expect(classifyRepository(input({ techStack: ['Docker'] })).type).toBe(
      'service',
    );
    expect(classifyRepository(input({ techStack: ['AWS SAM'] })).type).toBe(
      'service',
    );
    expect(
      classifyRepository(input({ techStack: ['Python', 'FastAPI'] })).type,
    ).toBe('service');
  });

  it('calls anything with a real deployment a service, whatever its manifests say', () => {
    const result = classifyRepository(
      input({ techStack: [], environmentTypes: ['Production'] }),
    );

    expect(result.type).toBe('service');
  });

  it('refuses to guess for a repository with no framework and no deployment', () => {
    // A library, a script, or something abandoned. Nothing here separates them,
    // and 38 of 95 repositories have no detected stack at all.
    expect(
      classifyRepository(input({ techStack: ['Python', 'pandas'] })).type,
    ).toBe('unknown');
    expect(classifyRepository(input()).type).toBe('unknown');
  });

  it('does not treat the AWS SDK as evidence of a service', () => {
    // A one-off script uses it too.
    expect(
      classifyRepository(input({ techStack: ['Python', 'AWS SDK'] })).type,
    ).toBe('unknown');
  });

  it('never claims a repository is a library', () => {
    // Half the estate has no CI because it is abandoned, not because it is a
    // library, and nothing stored distinguishes the two.
    const types = [
      classifyRepository(input({ techStack: ['TypeScript'] })).type,
      classifyRepository(input({ techStack: ['Node.js', 'Jest'] })).type,
      classifyRepository(input({ techStack: [] })).type,
    ];

    expect(types).not.toContain('library');
  });
});

describe('classifyRepository — lifecycle', () => {
  it('calls something that reaches production production', () => {
    const result = classifyRepository(
      input({ environmentTypes: ['Test', 'Staging', 'Production'] }),
    );

    expect(result.lifecycle).toBe('production');
  });

  it('calls something built but never live experimental', () => {
    const result = classifyRepository(
      input({ hasPipelineRuns: true, environmentTypes: ['Test'] }),
    );

    expect(result.lifecycle).toBe('experimental');
  });

  it('treats pipelines with no deployment at all as experimental', () => {
    // 25 of the 47 repositories with CI are in exactly this state: built, and
    // never observed in production.
    const result = classifyRepository(input({ hasPipelineRuns: true }));

    expect(result.lifecycle).toBe('experimental');
  });

  it('says unknown for a repository with no pipeline at all', () => {
    expect(classifyRepository(input()).lifecycle).toBe('unknown');
  });

  it('never calls a quiet repository deprecated', () => {
    // A quiet repository is not a retired one, and only its team knows the
    // difference. 57% of this estate is dormant.
    const lifecycles = [
      classifyRepository(input()).lifecycle,
      classifyRepository(input({ techStack: ['Python'] })).lifecycle,
      classifyRepository(input({ hasPipelineRuns: true })).lifecycle,
    ];

    expect(lifecycles).not.toContain('deprecated');
  });

  it('reads production from the type, not the free-text environment name', () => {
    // The estate spells environments `dev`, `Dev`, `production`, `Production`.
    // Bitbucket's three-way type is the only stable thing to test.
    expect(
      classifyRepository(input({ environmentTypes: ['Production'] })).lifecycle,
    ).toBe('production');
    expect(
      classifyRepository(input({ environmentTypes: ['Staging'] })).lifecycle,
    ).toBe('experimental');
  });
});

describe('classifyRepository — together', () => {
  it('classifies a real backend the way a reader would', () => {
    // oxp-backend: Python, deploys to dev and production.
    expect(
      classifyRepository(
        input({
          techStack: ['Python', 'Docker'],
          hasPipelineRuns: true,
          environmentTypes: ['Test', 'Production'],
        }),
      ),
    ).toEqual({ type: 'service', lifecycle: 'production' });
  });

  it('classifies a real front end the way a reader would', () => {
    // oxp-frontend: React, TypeScript, deploys to dev and production.
    expect(
      classifyRepository(
        input({
          techStack: ['Node.js', 'TypeScript', 'React'],
          hasPipelineRuns: true,
          environmentTypes: ['Test', 'Production'],
        }),
      ),
    ).toEqual({ type: 'website', lifecycle: 'production' });
  });

  it('leaves a dormant repository entirely unclaimed', () => {
    expect(classifyRepository(input())).toEqual({
      type: 'unknown',
      lifecycle: 'unknown',
    });
  });
});
