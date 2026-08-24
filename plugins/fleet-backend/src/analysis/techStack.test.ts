import { analyseTechStack, manifestsWorthReading } from './techStack';

describe('analyseTechStack', () => {
  describe('ecosystems from the root listing alone', () => {
    it('identifies nothing for a repository with no recognised manifest', () => {
      // 40 of 95 repositories in this estate are in exactly this position.
      const result = analyseTechStack(['README.md', 'LICENSE', '.gitignore']);

      expect(result).toEqual({ stack: [], language: undefined, evidence: [] });
    });

    it('identifies Node.js from package.json', () => {
      const result = analyseTechStack(['package.json']);

      expect(result.stack).toEqual(['Node.js']);
      expect(result.language).toBe('JavaScript');
    });

    it('identifies Python from any of its manifests', () => {
      for (const file of [
        'requirements.txt',
        'pyproject.toml',
        'setup.py',
        'Pipfile',
      ]) {
        const result = analyseTechStack([file]);
        expect(result.stack).toEqual(['Python']);
        expect(result.language).toBe('Python');
      }
    });

    it('identifies AWS SAM, which dominates this estate', () => {
      const result = analyseTechStack(['template.yaml', 'samconfig.toml']);

      expect(result.stack).toEqual(['AWS SAM']);
    });

    it('identifies Docker without treating it as a language', () => {
      const result = analyseTechStack(['Dockerfile']);

      expect(result.stack).toEqual(['Docker']);
      expect(result.language).toBeUndefined();
    });

    it('combines several ecosystems in one repository', () => {
      const result = analyseTechStack([
        'package.json',
        'Dockerfile',
        'template.yaml',
      ]);

      expect(result.stack).toEqual(['Node.js', 'Docker', 'AWS SAM']);
    });

    it('records which files justified the conclusion', () => {
      const result = analyseTechStack([
        'README.md',
        'package.json',
        'Dockerfile',
      ]);

      expect(result.evidence).toEqual(['package.json', 'Dockerfile']);
    });

    it('is case-insensitive about file names', () => {
      expect(analyseTechStack(['PACKAGE.JSON']).stack).toEqual(['Node.js']);
      expect(analyseTechStack(['dockerfile']).stack).toEqual(['Docker']);
    });

    it('never repeats a label', () => {
      const result = analyseTechStack([
        'template.yaml',
        'template.yml',
        'samconfig.toml',
      ]);

      expect(result.stack).toEqual(['AWS SAM']);
    });
  });

  describe('frameworks from manifest contents', () => {
    const pkg = (deps: Record<string, string>) =>
      JSON.stringify({ name: 'x', dependencies: deps });

    it('recognises a React application', () => {
      const result = analyseTechStack(['package.json'], {
        'package.json': pkg({ react: '^18.0.0', vite: '^5.0.0' }),
      });

      expect(result.stack).toEqual(
        expect.arrayContaining(['Node.js', 'React', 'Vite']),
      );
    });

    it('upgrades the language to TypeScript when it is a dependency', () => {
      const result = analyseTechStack(['package.json'], {
        'package.json': JSON.stringify({
          devDependencies: { typescript: '^5.0.0' },
        }),
      });

      expect(result.stack).toContain('TypeScript');
      expect(result.language).toBe('TypeScript');
    });

    it('leaves the language as JavaScript without TypeScript', () => {
      const result = analyseTechStack(['package.json'], {
        'package.json': pkg({ express: '^4.0.0' }),
      });

      expect(result.language).toBe('JavaScript');
      expect(result.stack).toContain('Express');
    });

    it('recognises scoped AWS SDK packages', () => {
      const result = analyseTechStack(['package.json'], {
        'package.json': pkg({ '@aws-sdk/client-s3': '^3.0.0' }),
      });

      expect(result.stack).toContain('AWS SDK');
    });

    it('recognises Python frameworks from requirement lines', () => {
      const result = analyseTechStack(['requirements.txt'], {
        'requirements.txt': 'fastapi==0.110.0\nboto3>=1.34\n# a comment\n',
      });

      expect(result.stack).toEqual(
        expect.arrayContaining(['Python', 'FastAPI', 'AWS SDK']),
      );
    });

    it('ignores commented-out requirements', () => {
      const result = analyseTechStack(['requirements.txt'], {
        'requirements.txt': '# django==5.0\nflask==3.0\n',
      });

      expect(result.stack).toContain('Flask');
      expect(result.stack).not.toContain('Django');
    });

    it('survives a malformed package.json rather than throwing', () => {
      const result = analyseTechStack(['package.json'], {
        'package.json': '{ this is not json',
      });

      expect(result.stack).toEqual(['Node.js']);
      expect(result.language).toBe('JavaScript');
    });

    it('survives an empty manifest', () => {
      const result = analyseTechStack(['package.json'], {
        'package.json': '{}',
      });

      expect(result.stack).toEqual(['Node.js']);
    });
  });

  describe('manifestsWorthReading', () => {
    it('selects only manifests whose contents add framework detail', () => {
      expect(
        manifestsWorthReading([
          'package.json',
          'requirements.txt',
          'pyproject.toml',
          'Dockerfile',
          'template.yaml',
          'README.md',
        ]),
      ).toEqual(['package.json', 'requirements.txt', 'pyproject.toml']);
    });

    it('selects nothing when there is nothing worth fetching', () => {
      expect(manifestsWorthReading(['README.md', 'Dockerfile'])).toEqual([]);
    });
  });
});
