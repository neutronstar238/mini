#include <iostream>
#include <random>
int main(){ std::mt19937 g(1); std::cout<<g()%10<<"\n"; }
