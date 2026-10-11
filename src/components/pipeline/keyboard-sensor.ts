import { KeyboardSensor, type KeyboardSensorOptions, type SensorProps } from "@dnd-kit/core";

/** The parts of dnd-kit's `KeyboardSensor` that are private in its typings. */
interface SensorInternals {
  handleKeyDown: (event: Event) => void;
  props: { onEnd: () => void; onCancel: () => void };
}

/**
 * dnd-kit's keyboard sensor starts listening for the arrow keys one task after it was activated (so the Space that picked the
 * card up is not taken as the Space that drops it). Input that arrives before that timer fires, which happens when the page is
 * busy re-rendering the board right after the pick-up (and with automated input), was lost, and the browser scrolled the board
 * with the arrow key instead. This sensor listens from the moment it exists, skipping only the activating key press itself, and
 * hands over to the library's own listener (the same function, so nothing is handled twice) once that is in place.
 */
export class EagerKeyboardSensor extends KeyboardSensor {
  static override activators = KeyboardSensor.activators;

  constructor(props: SensorProps<KeyboardSensorOptions>) {
    super(props);
    const self = this as unknown as SensorInternals;
    const activating = props.event;
    const doc = (props.event.target as Node | null)?.ownerDocument ?? document;
    const handle = self.handleKeyDown;
    let last: Event | null = null;
    // the library adds `this.handleKeyDown` in a timer that is already queued; it reads the property then, so it gets this wrapper
    self.handleKeyDown = (event) => {
      if (event === activating || event === last) return;
      last = event;
      handle(event);
    };
    doc.addEventListener("keydown", self.handleKeyDown);
    // the library removes its own listener when the drag ends; this early registration has to go with it
    const { onEnd, onCancel } = self.props;
    const release = () => doc.removeEventListener("keydown", self.handleKeyDown);
    self.props = {
      ...self.props,
      onEnd: () => {
        release();
        onEnd();
      },
      onCancel: () => {
        release();
        onCancel();
      },
    };
  }
}
