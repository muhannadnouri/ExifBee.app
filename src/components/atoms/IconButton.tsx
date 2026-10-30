import type { ButtonHTMLAttributes } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import './IconButton.css';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName;
  /** Accessible name and tooltip: an icon alone is not a label (NN/g icon usability). */
  label: string;
};

/** Icon-only button for universally known actions; the label is its name and its tooltip. */
export function IconButton({ icon, label, className, ...props }: Props) {
  return (
    <Button
      className={className ? `icon-button ${className}` : 'icon-button'}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={icon} />
    </Button>
  );
}
