import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { GLOSSARY } from '../../lib/glossary';
import { GlossaryTerm } from './GlossaryTerm';

test('the term reads as itself and its hint is the glossary sentence', async () => {
  render(
    <GlossaryTerm term="milestone" defaultOpen>
      Milestones
    </GlossaryTerm>
  );
  expect(screen.getByText('Milestones').dataset['glossary']).toBe('milestone');
  expect(await screen.findByText(GLOSSARY.milestone)).toBeTruthy();
});
