import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { HeaderSearch, isTypingTarget } from './HeaderSearch';

// The real modal needs the search API and a router. What is under test here is
// how the title bar opens it, so the modal is a marker that shows when open.
jest.mock('@backstage/plugin-search', () => ({
  useSearchModal: () => {
    const [open, setOpen] = useState(false);
    return {
      state: { open, hidden: !open },
      toggleModal: () => setOpen(o => !o),
      setOpen,
    };
  },
  SearchModal: ({ open }: { open?: boolean }) =>
    open ? <div role="dialog" aria-label="search window" /> : null,
}));

const isOpen = () => screen.queryByRole('dialog') !== null;

describe('HeaderSearch', () => {
  it('opens the search window when the box is clicked', () => {
    render(<HeaderSearch />);
    expect(isOpen()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Search the portal' }));
    expect(isOpen()).toBe(true);
  });

  it('opens the search window on "/" from anywhere on the page', () => {
    render(<HeaderSearch />);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(isOpen()).toBe(true);
  });

  it('leaves "/" alone while someone is typing in a field', () => {
    render(
      <>
        <input aria-label="Filter repositories" />
        <HeaderSearch />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText('Filter repositories'), {
      key: '/',
    });
    expect(isOpen()).toBe(false);
  });

  it('leaves "/" alone with a modifier held, which is a browser shortcut', () => {
    render(<HeaderSearch />);
    fireEvent.keyDown(document.body, { key: '/', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: '/', metaKey: true });
    expect(isOpen()).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('recognises fields, text areas, selects and editable regions', () => {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not compute isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    for (const element of [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      editable,
    ]) {
      expect(isTypingTarget(element)).toBe(true);
    }
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
