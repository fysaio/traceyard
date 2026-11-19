import React from 'react';
import { Platform, Text } from 'react-native';
import { label } from './checkout';

test('checkout renders a confirmation label', () => {
  const element = <Text accessibilityLabel={Platform.OS}>{label}</Text>;
  expect(element.props.accessibilityLabel).toBe('ios');
  expect(element.props.children).toBe('Ready');
});
