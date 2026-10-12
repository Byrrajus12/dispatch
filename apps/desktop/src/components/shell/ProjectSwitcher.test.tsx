import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { ProjectSwitcher, shortPath } from './ProjectSwitcher';

test('the home folder reads as ~', () => {
  expect(shortPath('/Users/ada/Sites/storefront')).toBe('~/Sites/storefront');
  expect(shortPath('/home/ada/code/app')).toBe('~/code/app');
  expect(shortPath('/Users/ada')).toBe('~');
});

test('paths outside a home folder are left alone', () => {
  expect(shortPath('/srv/repo')).toBe('/srv/repo');
  expect(shortPath('/Users')).toBe('/Users');
});

test('Help in the project menu restarts the first-task guide', async () => {
  const onRestartGuide = mock(() => {});
  render(
    <ProjectSwitcher
      projectName="storefront"
      projectPath="/Users/ada/storefront"
      noProjectYet={false}
      open
      onOpenChange={() => {}}
      switchProjects={[]}
      onSelectProject={() => {}}
      onAddProject={() => {}}
      onOpenSettings={() => {}}
      onRestartGuide={onRestartGuide}
    />
  );
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Restart the guide' })
  );
  expect(onRestartGuide).toHaveBeenCalledTimes(1);
});
