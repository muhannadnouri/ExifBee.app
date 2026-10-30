import './Checkbox.css';

type Props = { label: string; checked: boolean; onChange: (checked: boolean) => void };

/** Native checkbox with its label as the click target and accessible name. */
export function Checkbox({ label, checked, onChange }: Props) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
