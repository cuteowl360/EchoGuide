import React, { useEffect, useState } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { View, ActivityIndicator } from "react-native";

import LoginScreen from "./src/screens/LoginScreen";
import MainScreen  from "./src/screens/MainScreen";
import { getMe }   from "./src/api";

const Stack = createNativeStackNavigator();

export default function App() {
  const [initialRoute, setInitialRoute] = useState(null); // null = loading

  useEffect(() => {
    getMe()
      .then(user => setInitialRoute(user ? "Main" : "Login"))
      .catch(()  => setInitialRoute("Login"));
  }, []);

  if (!initialRoute) {
    return (
      <View style={{ flex: 1, backgroundColor: "#060a12", justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator color="#38bdf8" size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        initialRouteName={initialRoute}
        screenOptions={{ headerShown: false, animation: "fade" }}
      >
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="Main"  component={MainScreen}  />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
