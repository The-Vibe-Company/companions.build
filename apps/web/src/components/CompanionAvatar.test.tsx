import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,expect,it,vi} from 'vitest';
import {AvatarPicker,CompanionAvatar,randomizeAvatar} from './CompanionAvatar';

describe('randomizeAvatar', () => {
  it('returns values within the valid avatar ranges', () => {
    for (let i = 0; i < 20; i++) {
      const av = randomizeAvatar();
      expect(av.shape).toBeGreaterThanOrEqual(0);
      expect(av.shape).toBeLessThanOrEqual(7);
      expect(av.color).toBeGreaterThanOrEqual(0);
      expect(av.color).toBeLessThanOrEqual(10);
      expect(av.face).toBeGreaterThanOrEqual(0);
      expect(av.face).toBeLessThanOrEqual(4);
    }
  });

  it('does not always return the same value', () => {
    const values = new Set(Array.from({ length: 30 }, () => JSON.stringify(randomizeAvatar())));
    expect(values.size).toBeGreaterThan(1);
  });
});

it('renders the sticker outline with padded bounds, small highlighted eyes and its accessible name',()=>{
 const {container}=render(<CompanionAvatar name="Nova" avatar={{shape:7,color:4,face:0}}/>);
 const avatar=screen.getByRole('img',{name:'Nova, Companion'});
 expect(avatar).toHaveAttribute('viewBox','-4 -4 108 108');
 expect(container.querySelector('g')).toHaveAttribute('stroke-width','4.5');
 expect(container.querySelectorAll('circle[r="6.5"]')).toHaveLength(2);
 expect(container.querySelectorAll('circle[r="2"][fill="#fff"]')).toHaveLength(2);
});

it('keeps the full persisted appearance choices and makes sleep a temporary display state',async()=>{
 const onChange=vi.fn(),value={shape:7,color:10,face:4};
 const view=render(<AvatarPicker value={value} onChange={onChange}/>);
 expect(screen.getAllByRole('button',{name:/^Shape /})).toHaveLength(8);
 expect(screen.getAllByRole('button',{name:/^Color /})).toHaveLength(11);
 expect(screen.getAllByRole('button',{name:/^Face /})).toHaveLength(5);
 await userEvent.click(screen.getByRole('button',{name:'Shape 1'}));
 expect(onChange).toHaveBeenLastCalledWith({...value,shape:0});
 view.rerender(<CompanionAvatar name="Nova" avatar={{shape:7,color:10,face:0}} sleeping/>);
 expect(view.container.querySelectorAll('circle[r="6.5"]')).toHaveLength(0);
 view.rerender(<CompanionAvatar name="Nova" avatar={{shape:7,color:10,face:0}}/>);
 expect(view.container.querySelectorAll('circle[r="6.5"]')).toHaveLength(2);
});
